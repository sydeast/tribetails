package com.tribetails.auntieos.voice

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Three-state communication audio route. Replaces the deprecated binary
 * speakerphone-on/off concept that lied when a Bluetooth headset was active.
 */
enum class AudioRoute { Earpiece, Speaker, Bluetooth }

/**
 * Thin adapter over android.media.AudioDeviceInfo so the device-selection
 * helper stays unit-testable on the JVM without Robolectric.
 */
data class AudioDeviceInfoLike(val type: Int, val productName: String)

sealed class SelectionResult {
    data class Match(val device: AudioDeviceInfoLike) : SelectionResult()
    data class Missing(val reason: String) : SelectionResult()
}

/**
 * Picks the AudioDeviceInfo (adapter) matching the requested route.
 * Pure function - no Android system services touched, no I/O.
 */
fun selectCommunicationDevice(
    available: List<AudioDeviceInfoLike>,
    route: AudioRoute,
): SelectionResult {
    if (available.isEmpty()) {
        return SelectionResult.Missing("No communication devices available")
    }
    val targetTypes: Set<Int> = when (route) {
        AudioRoute.Earpiece -> setOf(AudioDeviceInfo.TYPE_BUILTIN_EARPIECE)
        AudioRoute.Speaker  -> setOf(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
        AudioRoute.Bluetooth -> setOf(
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
            AudioDeviceInfo.TYPE_BLE_HEADSET,
        )
    }
    val match = available.firstOrNull { it.type in targetTypes }
    return if (match != null) {
        SelectionResult.Match(match)
    } else {
        val reason = when (route) {
            AudioRoute.Bluetooth -> "No Bluetooth device available"
            AudioRoute.Speaker   -> "No speaker device available"
            AudioRoute.Earpiece  -> "No earpiece device available"
        }
        SelectionResult.Missing(reason)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// AudioRouter - the actual Android seam. Branches on Build.VERSION.SDK_INT.
// ─────────────────────────────────────────────────────────────────────────────

/** How long the platform gets to bring the SCO link up before we give up on it. */
const val SCO_CONNECT_TIMEOUT_MS = 5_000L

/**
 * Shown when the headset is connected to the phone but the SCO voice link
 * never came up - a timeout, or an explicit SCO_AUDIO_STATE_ERROR.
 */
const val SCO_DID_NOT_CONNECT_MESSAGE = "Bluetooth headset did not connect"

/** Shown when there is no Bluetooth headset paired and connected at all. */
const val NO_BLUETOOTH_DEVICE_MESSAGE = "No Bluetooth headset is connected"

/** Shown when a working SCO link drops part-way through a call. */
const val SCO_DROPPED_MESSAGE = "Bluetooth headset disconnected. Call moved to the earpiece."

/**
 * Owns audio routing for the in-call experience.
 *
 * Two genuinely different mechanisms sit behind one [setRoute]:
 *
 * - API 31+ picks a device: `setCommunicationDevice` succeeds or fails there
 *   and then, synchronously.
 * - API 26-30 has no such device list for Bluetooth. The earpiece and the
 *   speaker are a boolean (`isSpeakerphoneOn`), and a headset is a SCO link you
 *   ask the platform to open with `startBluetoothSco()`, which answers later on
 *   a broadcast and may never answer at all. So the legacy Bluetooth path is
 *   asynchronous, and [setRoute] returning true there means "the attempt
 *   started", not "you are on the headset". `currentRoute` stays on Earpiece
 *   until SCO actually reports CONNECTED, so the UI never claims a route the
 *   audio is not on.
 *
 * If SCO cannot be brought up, the call falls back to the earpiece and says so.
 * It is never left silent on a headset that is not carrying it.
 *
 * Fail-loud contract: every failure publishes to `audioRouteError` AND
 * routes through AuntieLog.w/e which auto-captures to Sentry.
 * Never silent.
 *
 * Threading: [setRoute], [release] and the SCO broadcast all land on the main
 * thread in production, but call teardown can also arrive on a Twilio callback
 * thread, so the mutating entry points are synchronized on this instance.
 */
class AudioRouter(
    private val audioManager: AudioManager,
    private val legacy: LegacyAudioSystem,
    private val sdkInt: Int = Build.VERSION.SDK_INT,
    private val scoTimeoutMs: Long = SCO_CONNECT_TIMEOUT_MS,
) {

    companion object {
        /** The production wiring: one AudioManager, one broadcast-backed legacy seam. */
        fun create(context: Context): AudioRouter {
            val app = context.applicationContext
            val am = app.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            return AudioRouter(am, AndroidLegacyAudioSystem(app, am))
        }
    }

    private val _currentRoute = MutableStateFlow(AudioRoute.Earpiece)
    val currentRoute: StateFlow<AudioRoute> = _currentRoute.asStateFlow()

    private val _audioRouteError = MutableStateFlow<String?>(null)
    val audioRouteError: StateFlow<String?> = _audioRouteError.asStateFlow()

    /** Where the legacy SCO link is in its lifecycle. Only meaningful below API 31. */
    private enum class ScoState { Off, Connecting, Connected }

    private var scoState = ScoState.Off
    private var scoTimeout: ScheduledAction? = null

    /** Set only when this router changed the audio mode, so it only restores its own. */
    private var modeBeforeSco: Int? = null

    private val isLegacy: Boolean get() = sdkInt < Build.VERSION_CODES.S

    /**
     * Attempts to switch the active comm device. Returns true on success.
     * On failure, publishes to audioRouteError + AuntieLog.w (which sends
     * Sentry.captureMessage at WARNING level).
     *
     * On API 26-30 a Bluetooth request returns true once the SCO attempt is
     * under way; the outcome arrives later via `currentRoute` or
     * `audioRouteError`.
     */
    @Synchronized
    fun setRoute(route: AudioRoute): Boolean {
        return if (isLegacy) setRouteLegacy(route) else setRouteApi31(route)
    }

    private fun setRouteApi31(route: AudioRoute): Boolean {
        val devices = audioManager.availableCommunicationDevices
            .map { AudioDeviceInfoLike(it.type, it.productName?.toString() ?: "") }
        val selection = selectCommunicationDevice(devices, route)
        when (selection) {
            is SelectionResult.Missing -> {
                val msg = "Audio route change failed: ${selection.reason}"
                AuntieLog.w(msg)
                _audioRouteError.value = msg
                return false
            }
            is SelectionResult.Match -> {
                val real = audioManager.availableCommunicationDevices
                    .firstOrNull { it.type == selection.device.type }
                if (real == null) {
                    val msg = "Audio route change failed: device disappeared between lookup and set"
                    AuntieLog.w(msg)
                    _audioRouteError.value = msg
                    return false
                }
                val ok = audioManager.setCommunicationDevice(real)
                if (!ok) {
                    val msg = "Audio route change failed: setCommunicationDevice returned false for $route"
                    AuntieLog.w(msg)
                    _audioRouteError.value = msg
                    return false
                }
                _currentRoute.value = route
                return true
            }
        }
    }

    // ── API 26-30 ────────────────────────────────────────────────────────────

    private fun setRouteLegacy(route: AudioRoute): Boolean {
        if (route == AudioRoute.Bluetooth) return startLegacyBluetooth()
        // Leaving Bluetooth on purpose: tear the link down first so the
        // DISCONNECTED broadcast it produces is not mistaken for a headset drop.
        teardownSco()
        legacy.setSpeakerphoneOn(route == AudioRoute.Speaker)
        _currentRoute.value = route
        return true
    }

    /**
     * Opens a SCO link to a connected headset. Asynchronous by nature: this
     * returns as soon as the request is in flight, and the broadcast (or the
     * timeout) decides what actually happens.
     */
    private fun startLegacyBluetooth(): Boolean {
        when (scoState) {
            // Already there. Re-tapping Bluetooth should not restart the link.
            ScoState.Connected -> {
                _currentRoute.value = AudioRoute.Bluetooth
                return true
            }
            // An attempt is in flight. Starting a second one double-registers
            // the receiver and confuses the timeout.
            ScoState.Connecting -> return true
            ScoState.Off -> Unit
        }

        val selection = selectCommunicationDevice(legacy.outputDevices(), AudioRoute.Bluetooth)
        if (selection is SelectionResult.Missing) {
            AuntieLog.w("$NO_BLUETOOTH_DEVICE_MESSAGE (${selection.reason})")
            _audioRouteError.value = NO_BLUETOOTH_DEVICE_MESSAGE
            return false
        }

        // SCO only carries call audio while the device is in communication
        // mode. IncomingCallNotificationService normally set this already; this
        // covers the case where it has not started yet, and remembers the old
        // value so release() restores only what this router changed.
        if (legacy.getMode() != AudioManager.MODE_IN_COMMUNICATION) {
            modeBeforeSco = legacy.getMode()
            legacy.setMode(AudioManager.MODE_IN_COMMUNICATION)
        }
        legacy.setSpeakerphoneOn(false)
        // Honest about where the audio is right now: the earpiece, until SCO says
        // otherwise. Publishing Bluetooth here would be a claim we cannot back.
        _currentRoute.value = AudioRoute.Earpiece

        scoState = ScoState.Connecting
        legacy.registerScoStateListener(::onScoStateChanged)
        scoTimeout = legacy.schedule(scoTimeoutMs) { onScoTimeout() }
        legacy.startBluetoothSco()
        return true
    }

    /**
     * ACTION_SCO_AUDIO_STATE_UPDATED is sticky: registering the receiver
     * usually delivers a DISCONNECTED straight away, before the attempt has had
     * any chance to resolve. So while connecting, only CONNECTED, an explicit
     * ERROR, or the timeout end the attempt - a DISCONNECTED counts as a
     * dropped headset only once we have actually been connected.
     */
    @Suppress("DEPRECATION") // SCO_AUDIO_STATE_* are deprecated at API 31; this is the API 26-30 path.
    @Synchronized
    internal fun onScoStateChanged(state: Int) {
        when (state) {
            AudioManager.SCO_AUDIO_STATE_CONNECTED -> {
                if (scoState == ScoState.Off) return
                scoTimeout?.cancel()
                scoTimeout = null
                scoState = ScoState.Connected
                legacy.setBluetoothScoOn(true)
                _currentRoute.value = AudioRoute.Bluetooth
                _audioRouteError.value = null
            }
            AudioManager.SCO_AUDIO_STATE_ERROR -> {
                if (scoState == ScoState.Off) return
                fallBackToEarpiece(SCO_DID_NOT_CONNECT_MESSAGE)
            }
            AudioManager.SCO_AUDIO_STATE_DISCONNECTED -> {
                if (scoState != ScoState.Connected) return
                fallBackToEarpiece(SCO_DROPPED_MESSAGE)
            }
        }
    }

    @Synchronized
    internal fun onScoTimeout() {
        if (scoState != ScoState.Connecting) return
        fallBackToEarpiece(SCO_DID_NOT_CONNECT_MESSAGE)
    }

    /** The only ending for a failed Bluetooth route: audible on the earpiece, and said out loud. */
    private fun fallBackToEarpiece(message: String) {
        teardownSco()
        legacy.setSpeakerphoneOn(false)
        _currentRoute.value = AudioRoute.Earpiece
        AuntieLog.w(message)
        _audioRouteError.value = message
    }

    /**
     * Drops the SCO link and everything watching it. State is cleared and the
     * listener removed BEFORE stopBluetoothSco(), so the DISCONNECTED broadcast
     * that follows is not read back as a headset drop.
     */
    private fun teardownSco() {
        scoTimeout?.cancel()
        scoTimeout = null
        val wasActive = scoState != ScoState.Off
        scoState = ScoState.Off
        legacy.unregisterScoStateListener()
        if (wasActive) {
            legacy.setBluetoothScoOn(false)
            legacy.stopBluetoothSco()
        }
    }

    /**
     * Call teardown. Without this a legacy device keeps the SCO link open and
     * the audio mode changed after the call ends, which leaves music and the
     * next call routed to a headset nobody asked for until the process restarts.
     */
    @Synchronized
    fun release() {
        if (isLegacy) {
            teardownSco()
            legacy.setSpeakerphoneOn(false)
            modeBeforeSco?.let {
                legacy.setMode(it)
                modeBeforeSco = null
            }
        }
        _currentRoute.value = AudioRoute.Earpiece
    }

    /**
     * Returns the set of routes the user can currently select. The route toggle
     * disables any cell not in this set, so leaving Bluetooth out of the legacy
     * answer is what greyed the button out on Android 8-11.
     *
     * On legacy the two builtins are always there, and Bluetooth joins them when
     * Android reports a connected SCO headset among its output devices. On API
     * 31+ the whole set comes from availableCommunicationDevices.
     */
    fun availableRoutes(): Set<AudioRoute> {
        if (isLegacy) {
            val routes = mutableSetOf(AudioRoute.Earpiece, AudioRoute.Speaker)
            val bluetooth = selectCommunicationDevice(legacy.outputDevices(), AudioRoute.Bluetooth)
            if (bluetooth is SelectionResult.Match) routes += AudioRoute.Bluetooth
            return routes
        }
        val types = audioManager.availableCommunicationDevices.map { it.type }.toSet()
        val routes = mutableSetOf<AudioRoute>()
        if (AudioDeviceInfo.TYPE_BUILTIN_EARPIECE in types) routes += AudioRoute.Earpiece
        if (AudioDeviceInfo.TYPE_BUILTIN_SPEAKER  in types) routes += AudioRoute.Speaker
        if (AudioDeviceInfo.TYPE_BLUETOOTH_SCO in types || AudioDeviceInfo.TYPE_BLE_HEADSET in types) {
            routes += AudioRoute.Bluetooth
        }
        if (routes.isEmpty()) {
            // Safety net: if Android reports zero comm devices, surface but
            // still offer the two builtins so the user has a usable UI.
            AuntieLog.w("availableCommunicationDevices was empty; defaulting to Earpiece+Speaker")
            return setOf(AudioRoute.Earpiece, AudioRoute.Speaker)
        }
        return routes
    }

    /**
     * Reads the current system state and updates currentRoute without writing
     * to the system. Called from CallInviteManager.answer() so the StateFlow
     * starts in sync with whatever route Android already selected.
     */
    @Synchronized
    fun syncFromSystem() {
        if (!isLegacy) {
            val active = audioManager.communicationDevice
            _currentRoute.value = when (active?.type) {
                AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> AudioRoute.Speaker
                AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> AudioRoute.Bluetooth
                else -> AudioRoute.Earpiece
            }
            return
        }
        // SCO first: a headset already carrying audio outranks the speakerphone
        // flag, which can still read true underneath an active SCO link.
        if (legacy.isBluetoothScoOn()) {
            _currentRoute.value = AudioRoute.Bluetooth
            if (scoState == ScoState.Off) {
                // Adopt a link somebody else opened, so a later drop still falls
                // back to the earpiece instead of going quiet, and so release()
                // closes it at the end of the call.
                scoState = ScoState.Connected
                legacy.registerScoStateListener(::onScoStateChanged)
            }
            return
        }
        _currentRoute.value =
            if (legacy.isSpeakerphoneOn()) AudioRoute.Speaker else AudioRoute.Earpiece
    }

    fun clearError() {
        _audioRouteError.value = null
    }
}
