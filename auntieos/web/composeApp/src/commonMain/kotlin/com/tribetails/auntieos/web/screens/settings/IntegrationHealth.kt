package com.tribetails.auntieos.web.screens.settings

import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone

/**
 * Health state per integration on the web Integrations panel. Mirrors the Android
 * IntegrationHealth model so the same integration reads the same on both consoles.
 * Firestore is probed live (derived from the real settings-load result); n8n, FCM
 * and Twilio stay CONFIGURED - they are server-side managed and a client-side ping
 * from the web admin console is not meaningful (FCM in particular delivers to the
 * mobile apps, not this console).
 */
enum class IntegrationHealthState {
    HEALTHY,         // Recent successful round-trip
    CONFIGURED,      // Reachable in principle but no live probe; server-side managed
    DISCONNECTED,    // Probe failed
    CHECKING,        // Probe in flight
    UNKNOWN,         // Not yet probed
}

fun integrationPillLabel(state: IntegrationHealthState): String = when (state) {
    IntegrationHealthState.HEALTHY      -> "HEALTHY"
    IntegrationHealthState.CONFIGURED   -> "CONFIGURED"
    IntegrationHealthState.DISCONNECTED -> "DISCONNECTED"
    IntegrationHealthState.CHECKING     -> "CHECKING"
    IntegrationHealthState.UNKNOWN      -> "UNKNOWN"
}

fun integrationPillTone(state: IntegrationHealthState): AuntieStatusTone = when (state) {
    IntegrationHealthState.HEALTHY      -> AuntieStatusTone.Success
    IntegrationHealthState.CONFIGURED   -> AuntieStatusTone.Orange
    IntegrationHealthState.DISCONNECTED -> AuntieStatusTone.Error
    IntegrationHealthState.CHECKING     -> AuntieStatusTone.Warning
    IntegrationHealthState.UNKNOWN      -> AuntieStatusTone.Neutral
}

/** Pure probe-result interpretation (mirrors Android). */
fun firestoreHealthFromProbe(succeeded: Boolean): IntegrationHealthState =
    if (succeeded) IntegrationHealthState.HEALTHY else IntegrationHealthState.DISCONNECTED

/**
 * Derives Firestore health from the live settings-load result the screen already
 * holds - no extra round-trip. A loaded doc proves the read path works (HEALTHY);
 * an error means the listener failed (DISCONNECTED); still loading is CHECKING.
 */
fun integrationHealthFromResult(result: FirestoreResult<*>): IntegrationHealthState = when (result) {
    is FirestoreResult.Data    -> IntegrationHealthState.HEALTHY
    is FirestoreResult.Error   -> IntegrationHealthState.DISCONNECTED
    FirestoreResult.Loading    -> IntegrationHealthState.CHECKING
}
