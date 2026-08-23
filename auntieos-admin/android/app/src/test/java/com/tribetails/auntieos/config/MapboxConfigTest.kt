package com.tribetails.auntieos.config

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * The handover itself, against a fake sink.
 *
 * `MapboxTokenStartupTest` proves startup calls this; this proves what it does,
 * including the two failure paths that must not reach a user: an unconfigured
 * build, and the SDK throwing. A blank basemap is an acceptable degradation on
 * a device with no token. A crash on launch is not, and the crash is the live
 * risk, because the real sink is a native call.
 */
class MapboxConfigTest {

    private val delivered = mutableListOf<String>()

    @Before
    fun setUp() {
        MapboxConfig.resetForTests { delivered += it }
    }

    @After
    fun tearDown() {
        // Restores the real native sink. Without this the fake leaks into every
        // later test in the JVM, which is how issue #425 happened.
        MapboxConfig.resetForTests()
    }

    @Test
    fun a_configured_token_reaches_the_sdk() {
        val outcome = MapboxConfig.applyAccessToken("pk.test-token")

        assertEquals(listOf("pk.test-token"), delivered)
        assertEquals(MapboxConfig.TokenApplication.Delivered("pk.test-token"), outcome)
        assertEquals(outcome, MapboxConfig.startupTokenApplication)
    }

    @Test
    fun a_blank_token_is_recorded_as_unconfigured_and_never_handed_over() {
        val outcome = MapboxConfig.applyAccessToken("   ")

        assertTrue("nothing should reach the SDK", delivered.isEmpty())
        assertEquals(MapboxConfig.TokenApplication.NoTokenConfigured, outcome)
        assertEquals(outcome, MapboxConfig.startupTokenApplication)
    }

    @Test
    fun an_sdk_failure_is_recorded_and_not_thrown_at_startup() {
        // The real sink is a native call: under Robolectric it raises
        // UnsatisfiedLinkError, which is an Error rather than an Exception, so
        // this pins that the catch is wide enough. A map failing must not take
        // down an app whose other screens have nothing to do with maps.
        MapboxConfig.resetForTests { throw UnsatisfiedLinkError("no native lib") }

        val outcome = MapboxConfig.applyAccessToken("pk.test-token")

        assertTrue(outcome is MapboxConfig.TokenApplication.Delivered)
        val recorded = outcome as MapboxConfig.TokenApplication.Delivered
        assertEquals("pk.test-token", recorded.token)
        assertNotNull("the failure must be recorded, not swallowed", recorded.deliveryError)
        assertEquals(outcome, MapboxConfig.startupTokenApplication)
    }

    @Test
    fun nothing_has_consulted_the_token_before_startup_runs() {
        MapboxConfig.resetForTests { delivered += it }

        assertEquals(MapboxConfig.TokenApplication.NeverConsulted, MapboxConfig.startupTokenApplication)
        assertNull(
            "NeverConsulted must be distinguishable from an unconfigured build",
            (MapboxConfig.startupTokenApplication as? MapboxConfig.TokenApplication.Delivered)?.token,
        )
    }
}
