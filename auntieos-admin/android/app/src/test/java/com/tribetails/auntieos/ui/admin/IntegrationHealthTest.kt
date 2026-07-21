package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pure-JVM tests for IntegrationHealth helpers. The pill label mapping and
 * probe-result interpretation are pure functions, so we can verify the entire
 * UI-state matrix without Firebase, Robolectric, or Compose.
 */
class IntegrationHealthTest {

    @Test
    fun `integrationPillLabel HEALTHY maps to HEALTHY`() {
        assertEquals("HEALTHY", integrationPillLabel(IntegrationHealthState.HEALTHY))
    }

    @Test
    fun `integrationPillLabel CONFIGURED maps to CONFIGURED`() {
        assertEquals("CONFIGURED", integrationPillLabel(IntegrationHealthState.CONFIGURED))
    }

    @Test
    fun `integrationPillLabel DISCONNECTED maps to DISCONNECTED`() {
        assertEquals("DISCONNECTED", integrationPillLabel(IntegrationHealthState.DISCONNECTED))
    }

    @Test
    fun `integrationPillLabel CHECKING maps to CHECKING`() {
        assertEquals("CHECKING", integrationPillLabel(IntegrationHealthState.CHECKING))
    }

    @Test
    fun `integrationPillLabel UNKNOWN maps to UNKNOWN`() {
        assertEquals("UNKNOWN", integrationPillLabel(IntegrationHealthState.UNKNOWN))
    }

    @Test
    fun `firestoreHealthFromProbe true yields HEALTHY`() {
        assertEquals(IntegrationHealthState.HEALTHY, firestoreHealthFromProbe(true))
    }

    @Test
    fun `firestoreHealthFromProbe false yields DISCONNECTED`() {
        assertEquals(IntegrationHealthState.DISCONNECTED, firestoreHealthFromProbe(false))
    }

    @Test
    fun `fcmHealthFromTokenPresence true yields HEALTHY`() {
        assertEquals(IntegrationHealthState.HEALTHY, fcmHealthFromTokenPresence(true))
    }

    @Test
    fun `fcmHealthFromTokenPresence false yields CONFIGURED`() {
        assertEquals(IntegrationHealthState.CONFIGURED, fcmHealthFromTokenPresence(false))
    }
}
