package com.tribetails.auntieos.ui.admin

// Health state per integration. The pill UI maps each state to a color +
// label. Live checks only run for Firestore + FCM (the channels Android can
// actually probe cheaply); n8n and Twilio stay CONFIGURED - they're managed
// server-side and a client-side ping isn't meaningful.
enum class IntegrationHealthState {
    HEALTHY,         // Recent successful round-trip
    CONFIGURED,      // Reachable in principle but no live probe; server-side managed
    DISCONNECTED,    // Probe failed
    CHECKING,        // Probe in flight
    UNKNOWN,         // Not yet probed
}

data class IntegrationHealth(
    val name: String,
    val description: String,
    val state: IntegrationHealthState,
)

fun integrationPillLabel(state: IntegrationHealthState): String = when (state) {
    IntegrationHealthState.HEALTHY      -> "HEALTHY"
    IntegrationHealthState.CONFIGURED   -> "CONFIGURED"
    IntegrationHealthState.DISCONNECTED -> "DISCONNECTED"
    IntegrationHealthState.CHECKING     -> "CHECKING"
    IntegrationHealthState.UNKNOWN      -> "UNKNOWN"
}

// Probe-result interpretation helpers. Pure (no Firebase), JVM-testable.
fun firestoreHealthFromProbe(succeeded: Boolean): IntegrationHealthState =
    if (succeeded) IntegrationHealthState.HEALTHY else IntegrationHealthState.DISCONNECTED

fun fcmHealthFromTokenPresence(hasToken: Boolean): IntegrationHealthState =
    if (hasToken) IntegrationHealthState.HEALTHY else IntegrationHealthState.CONFIGURED
