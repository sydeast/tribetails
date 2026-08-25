package com.kinfolk.portal.config

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The handover itself, against a fake sink.
 *
 * `MapboxTokenStartupTest` proves startup calls this; this proves what it does
 * when it is called. Split because the real sink writes to `MapboxOptions`,
 * which throws `UnsatisfiedLinkError` in a JVM unit test, so the applied value
 * can never be read back - only the record of the attempt can.
 */
class MapboxPortalConfigTest {

    @After
    fun tearDown() {
        MapboxPortalConfig.resetForTests()
    }

    @Test
    fun a_token_reaches_the_sdk_and_is_recorded() {
        val handed = mutableListOf<String>()
        MapboxPortalConfig.resetForTests(sink = { handed += it })

        val outcome = MapboxPortalConfig.applyAccessToken("pk.a-public-token")

        assertEquals(listOf("pk.a-public-token"), handed)
        assertEquals(
            MapboxPortalConfig.TokenApplication.Delivered("pk.a-public-token"),
            outcome,
        )
        assertEquals(outcome, MapboxPortalConfig.startupTokenApplication)
    }

    @Test
    fun a_blank_token_is_an_ordinary_build_and_never_reaches_the_sdk() {
        val handed = mutableListOf<String>()
        MapboxPortalConfig.resetForTests(sink = { handed += it })

        val outcome = MapboxPortalConfig.applyAccessToken("")

        assertEquals("nothing may be handed to the SDK", emptyList<String>(), handed)
        assertEquals(MapboxPortalConfig.TokenApplication.NoTokenConfigured, outcome)
        assertEquals(outcome, MapboxPortalConfig.startupTokenApplication)
    }

    @Test
    fun whitespace_is_no_token_at_all() {
        MapboxPortalConfig.resetForTests(sink = { })
        assertEquals(
            MapboxPortalConfig.TokenApplication.NoTokenConfigured,
            MapboxPortalConfig.applyAccessToken("   "),
        )
    }

    @Test
    fun a_sink_that_throws_does_not_take_down_startup() {
        // The real sink is a native SDK call. An app with twenty screens that do
        // not involve a map must not fail to launch because one of them would
        // have.
        val boom = UnsatisfiedLinkError("no native library in a unit test")
        MapboxPortalConfig.resetForTests(sink = { throw boom })

        val outcome = MapboxPortalConfig.applyAccessToken("pk.a-public-token")

        assertTrue(outcome is MapboxPortalConfig.TokenApplication.Delivered)
        outcome as MapboxPortalConfig.TokenApplication.Delivered
        assertEquals(
            "startup did its part, and the failure is recorded rather than swallowed",
            boom,
            outcome.deliveryError,
        )
    }

    @Test
    fun nothing_is_recorded_before_startup_runs() {
        MapboxPortalConfig.resetForTests(sink = { })
        assertEquals(
            MapboxPortalConfig.TokenApplication.NeverConsulted,
            MapboxPortalConfig.startupTokenApplication,
        )
    }

    @Test
    fun a_successful_delivery_carries_no_error() {
        MapboxPortalConfig.resetForTests(sink = { })
        val outcome = MapboxPortalConfig.applyAccessToken("pk.a-public-token")
        assertNull((outcome as MapboxPortalConfig.TokenApplication.Delivered).deliveryError)
    }
}
