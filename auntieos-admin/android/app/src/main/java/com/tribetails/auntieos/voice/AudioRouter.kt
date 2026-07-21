package com.tribetails.auntieos.voice

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

/**
 * Owns audio routing for the in-call experience. API 31+ uses the modern
 * setCommunicationDevice API; API 26-30 falls back to isSpeakerphoneOn.
 *
 * Fail-loud contract: every failure publishes to `audioRouteError` AND
 * routes through AuntieLog.w/e which auto-captures to Sentry.
 * Never silent.
 */
class AudioRouter(private val audioManager: AudioManager) {

    private val _currentRoute = MutableStateFlow(AudioRoute.Earpiece)
    val currentRoute: StateFlow<AudioRoute> = _currentRoute.asStateFlow()

    private val _audioRouteError = MutableStateFlow<String?>(null)
    val audioRouteError: StateFlow<String?> = _audioRouteError.asStateFlow()

    /**
     * Attempts to switch the active comm device. Returns true on success.
     * On failure, publishes to audioRouteError + AuntieLog.w (which sends
     * Sentry.captureMessage at WARNING level).
     */
    fun setRoute(route: AudioRoute): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            setRouteApi31(route)
        } else {
            @Suppress("DEPRECATION")
            setRouteLegacy(route)
        }
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

    @Suppress("DEPRECATION")
    private fun setRouteLegacy(route: AudioRoute): Boolean {
        // API 26-30: only Speaker vs Earpiece is selectable via this API.
        // Bluetooth on legacy requires startBluetoothSco() which is out of scope
        // for this plan (PR-B will introduce audioswitch for full BT support).
        if (route == AudioRoute.Bluetooth) {
            val msg = "Bluetooth routing requires API 31+; current device runs API ${Build.VERSION.SDK_INT}"
            AuntieLog.w(msg)
            _audioRouteError.value = msg
            return false
        }
        audioManager.isSpeakerphoneOn = (route == AudioRoute.Speaker)
        _currentRoute.value = route
        return true
    }

    /**
     * Returns the set of routes the user can currently select.
     * On legacy: always [Earpiece, Speaker]. On API 31+: derived from
     * audioManager.availableCommunicationDevices.
     */
    fun availableRoutes(): Set<AudioRoute> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            return setOf(AudioRoute.Earpiece, AudioRoute.Speaker)
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
    fun syncFromSystem() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val active = audioManager.communicationDevice
            _currentRoute.value = when (active?.type) {
                AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> AudioRoute.Speaker
                AudioDeviceInfo.TYPE_BLUETOOTH_SCO, AudioDeviceInfo.TYPE_BLE_HEADSET -> AudioRoute.Bluetooth
                else -> AudioRoute.Earpiece
            }
        } else {
            @Suppress("DEPRECATION")
            _currentRoute.value =
                if (audioManager.isSpeakerphoneOn) AudioRoute.Speaker else AudioRoute.Earpiece
        }
    }

    fun clearError() {
        _audioRouteError.value = null
    }
}
