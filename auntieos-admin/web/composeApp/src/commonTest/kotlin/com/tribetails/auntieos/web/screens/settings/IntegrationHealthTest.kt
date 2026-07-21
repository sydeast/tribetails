package com.tribetails.auntieos.web.screens.settings

import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Pins the web Integrations health model. Mirrors the Android IntegrationHealth so
 * the same integration reads the same on both consoles. Firestore health is
 * derived from the real settings-load result (no placeholder "Static config");
 * n8n / FCM / Twilio stay CONFIGURED (server-managed, no meaningful client probe
 * from the web admin console).
 */
class IntegrationHealthTest {

    @Test
    fun pillLabel_perState() {
        assertEquals("HEALTHY", integrationPillLabel(IntegrationHealthState.HEALTHY))
        assertEquals("CONFIGURED", integrationPillLabel(IntegrationHealthState.CONFIGURED))
        assertEquals("DISCONNECTED", integrationPillLabel(IntegrationHealthState.DISCONNECTED))
        assertEquals("CHECKING", integrationPillLabel(IntegrationHealthState.CHECKING))
        assertEquals("UNKNOWN", integrationPillLabel(IntegrationHealthState.UNKNOWN))
    }

    @Test
    fun pillTone_perState() {
        assertEquals(AuntieStatusTone.Success, integrationPillTone(IntegrationHealthState.HEALTHY))
        assertEquals(AuntieStatusTone.Orange, integrationPillTone(IntegrationHealthState.CONFIGURED))
        assertEquals(AuntieStatusTone.Error, integrationPillTone(IntegrationHealthState.DISCONNECTED))
        assertEquals(AuntieStatusTone.Warning, integrationPillTone(IntegrationHealthState.CHECKING))
        assertEquals(AuntieStatusTone.Neutral, integrationPillTone(IntegrationHealthState.UNKNOWN))
    }

    @Test
    fun firestoreHealthFromProbe_mapsSuccessAndFailure() {
        assertEquals(IntegrationHealthState.HEALTHY, firestoreHealthFromProbe(true))
        assertEquals(IntegrationHealthState.DISCONNECTED, firestoreHealthFromProbe(false))
    }

    @Test
    fun integrationHealthFromResult_data_isHealthy() {
        assertEquals(
            IntegrationHealthState.HEALTHY,
            integrationHealthFromResult(FirestoreResult.Data("any")),
        )
    }

    @Test
    fun integrationHealthFromResult_error_isDisconnected() {
        assertEquals(
            IntegrationHealthState.DISCONNECTED,
            integrationHealthFromResult(FirestoreResult.Error("boom")),
        )
    }

    @Test
    fun integrationHealthFromResult_loading_isChecking() {
        assertEquals(
            IntegrationHealthState.CHECKING,
            integrationHealthFromResult(FirestoreResult.Loading),
        )
    }
}
