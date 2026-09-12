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

    // Issue #755: the settings mock's `.logo` letter and its gradient pick.

    @Test
    fun `integrationMonogram is the upper-cased first letter, trimmed`() {
        assertEquals("G", integrationMonogram("Google Calendar"))
        assertEquals("N", integrationMonogram("  n8n automations"))
        assertEquals("S", integrationMonogram("smtp2go"))
    }

    @Test
    fun `integrationMonogram never renders an empty tile`() {
        assertEquals("?", integrationMonogram(""))
        assertEquals("?", integrationMonogram("   "))
    }

    @Test
    fun `integrationGradientIndex is stable and always in range`() {
        val names = listOf("Stripe", "Twilio", "Mapbox", "Cloudinary", "Google Calendar", "Sentry", "smtp2go")
        for (name in names) {
            val first = integrationGradientIndex(name, 3)
            assertEquals(first, integrationGradientIndex(name, 3))
            assert(first in 0 until 3) { "$name picked $first" }
        }
        assertEquals(0, integrationGradientIndex("", 3))
    }
}
