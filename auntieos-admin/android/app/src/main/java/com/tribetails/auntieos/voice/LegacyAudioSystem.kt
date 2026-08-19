package com.tribetails.auntieos.voice

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import com.tribetails.auntieos.util.AuntieLog

/** Handle for a delayed action, so the SCO connect timeout can be cancelled. */
interface ScheduledAction {
    fun cancel()
}

/**
 * Everything the API 26-30 Bluetooth path touches on the Android side, behind
 * one narrow interface.
 *
 * Bluetooth on those releases is not a device you select: it is a SCO link you
 * ask the platform to open, which then succeeds or fails asynchronously over a
 * broadcast. None of that can be exercised on a JVM against the real
 * AudioManager, so the whole surface lives here and [AudioRouter] talks only to
 * this. The production implementation below is deliberately a humble object -
 * pure delegation, no decisions - because it is the one piece a unit test
 * cannot reach. Every decision about ordering, timeouts and fallback lives in
 * AudioRouter, where the fake can drive it.
 */
interface LegacyAudioSystem {
    /** Output devices Android currently reports. Used to spot a connected headset. */
    fun outputDevices(): List<AudioDeviceInfoLike>

    fun getMode(): Int
    fun setMode(mode: Int)

    fun isSpeakerphoneOn(): Boolean
    fun setSpeakerphoneOn(on: Boolean)

    fun isBluetoothScoOn(): Boolean
    fun setBluetoothScoOn(on: Boolean)

    /** Asks the platform to open the SCO link. Resolves via the broadcast, not here. */
    fun startBluetoothSco()

    /** Tears the SCO link down. */
    fun stopBluetoothSco()

    /**
     * Starts listening for ACTION_SCO_AUDIO_STATE_UPDATED, handing the listener
     * the EXTRA_SCO_AUDIO_STATE value. Calling twice without an unregister in
     * between must not attach a second listener.
     */
    fun registerScoStateListener(listener: (Int) -> Unit)

    /** Stops listening. Safe to call when nothing is registered. */
    fun unregisterScoStateListener()

    /** Runs [action] after [delayMs], unless the returned handle is cancelled first. */
    fun schedule(delayMs: Long, action: () -> Unit): ScheduledAction
}

/**
 * The real thing, on top of AudioManager and a broadcast receiver.
 *
 * startBluetoothSco / stopBluetoothSco / isSpeakerphoneOn are all deprecated as
 * of API 31, which is exactly why this class exists: it is only ever used below
 * API 31, where they are the only way to reach a Bluetooth headset. API 31+
 * goes through setCommunicationDevice and never constructs this.
 */
@Suppress("DEPRECATION")
class AndroidLegacyAudioSystem(
    private val context: Context,
    private val audioManager: AudioManager,
) : LegacyAudioSystem {

    private val handler = Handler(Looper.getMainLooper())
    private var receiver: BroadcastReceiver? = null

    override fun outputDevices(): List<AudioDeviceInfoLike> =
        audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
            .map { AudioDeviceInfoLike(it.type, it.productName?.toString() ?: "") }

    override fun getMode(): Int = audioManager.mode

    override fun setMode(mode: Int) {
        audioManager.mode = mode
    }

    override fun isSpeakerphoneOn(): Boolean = audioManager.isSpeakerphoneOn

    override fun setSpeakerphoneOn(on: Boolean) {
        audioManager.isSpeakerphoneOn = on
    }

    override fun isBluetoothScoOn(): Boolean = audioManager.isBluetoothScoOn

    override fun setBluetoothScoOn(on: Boolean) {
        audioManager.isBluetoothScoOn = on
    }

    override fun startBluetoothSco() {
        audioManager.startBluetoothSco()
    }

    override fun stopBluetoothSco() {
        audioManager.stopBluetoothSco()
    }

    override fun registerScoStateListener(listener: (Int) -> Unit) {
        if (receiver != null) return
        val fresh = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context?, intent: Intent?) {
                // A missing extra is treated as an error rather than as a
                // connect: silently believing SCO came up would send the call
                // to a headset that is not carrying it.
                val state = intent?.getIntExtra(
                    AudioManager.EXTRA_SCO_AUDIO_STATE,
                    AudioManager.SCO_AUDIO_STATE_ERROR,
                ) ?: AudioManager.SCO_AUDIO_STATE_ERROR
                listener(state)
            }
        }
        receiver = fresh
        ContextCompat.registerReceiver(
            context,
            fresh,
            IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
    }

    override fun unregisterScoStateListener() {
        val current = receiver ?: return
        receiver = null
        try {
            context.unregisterReceiver(current)
        } catch (e: IllegalArgumentException) {
            // Android throws rather than no-opping when the receiver is already
            // gone. Not worth failing a call teardown over, but not worth
            // hiding either.
            AuntieLog.w("SCO state receiver was already unregistered", e)
        }
    }

    override fun schedule(delayMs: Long, action: () -> Unit): ScheduledAction {
        val runnable = Runnable { action() }
        handler.postDelayed(runnable, delayMs)
        return object : ScheduledAction {
            override fun cancel() {
                handler.removeCallbacks(runnable)
            }
        }
    }
}
