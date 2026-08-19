package com.tribetails.auntieos.voice

import android.media.AudioManager

/**
 * Stand-in for the API 26-30 audio surface, so the SCO state machine can be
 * driven from a plain JVM test: no headset, no broadcast, no Handler.
 *
 * Everything the router asks for is a field, and the two things the platform
 * would normally decide - when the SCO broadcast arrives, and when the connect
 * timeout fires - are methods the test calls: [emitScoState] and [fireTimeout].
 */
class FakeLegacyAudioSystem(
    private var devices: List<AudioDeviceInfoLike> = emptyList(),
) : LegacyAudioSystem {

    /** Named apart from the interface accessors so the JVM signatures do not clash. */
    var audioMode: Int = AudioManager.MODE_NORMAL
    var speakerOn: Boolean = false
    var scoOn: Boolean = false

    var startScoCalls: Int = 0
        private set
    var stopScoCalls: Int = 0
        private set

    /** Non-null while a listener is attached; the register/unregister balance. */
    var scoListener: ((Int) -> Unit)? = null
        private set
    var registerCalls: Int = 0
        private set
    var unregisterCalls: Int = 0
        private set

    private var pendingTimeout: (() -> Unit)? = null
    var scheduledDelayMs: Long? = null
        private set

    val timeoutScheduled: Boolean get() = pendingTimeout != null

    fun setDevices(vararg types: Int) {
        devices = types.map { AudioDeviceInfoLike(it, "fake-$it") }
    }

    override fun outputDevices(): List<AudioDeviceInfoLike> = devices

    override fun getMode(): Int = audioMode

    override fun setMode(mode: Int) {
        audioMode = mode
    }

    override fun isSpeakerphoneOn(): Boolean = speakerOn

    override fun setSpeakerphoneOn(on: Boolean) {
        speakerOn = on
    }

    override fun isBluetoothScoOn(): Boolean = scoOn

    override fun setBluetoothScoOn(on: Boolean) {
        scoOn = on
    }

    override fun startBluetoothSco() {
        startScoCalls++
    }

    override fun stopBluetoothSco() {
        stopScoCalls++
    }

    override fun registerScoStateListener(listener: (Int) -> Unit) {
        registerCalls++
        // Matches the real receiver: a second register with none pending in
        // between must not attach a second listener.
        if (scoListener != null) return
        scoListener = listener
    }

    override fun unregisterScoStateListener() {
        unregisterCalls++
        scoListener = null
    }

    override fun schedule(delayMs: Long, action: () -> Unit): ScheduledAction {
        scheduledDelayMs = delayMs
        pendingTimeout = action
        return object : ScheduledAction {
            override fun cancel() {
                if (pendingTimeout === action) {
                    pendingTimeout = null
                    scheduledDelayMs = null
                }
            }
        }
    }

    /** Delivers one ACTION_SCO_AUDIO_STATE_UPDATED, if anything is listening. */
    fun emitScoState(state: Int) {
        scoListener?.invoke(state)
    }

    /** Runs the scheduled connect timeout, if it has not been cancelled. */
    fun fireTimeout() {
        val action = pendingTimeout ?: return
        pendingTimeout = null
        scheduledDelayMs = null
        action()
    }
}
