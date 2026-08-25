package com.tribetails.auntieos.data.repository

import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

/**
 * Issue #576 on Android: activation has to be OBSERVABLE, and a failure has to
 * be loud.
 *
 * The defect class this guards against is not a misconfiguration. The kinfolk
 * portal shipped App Check code behind a readiness guard that was always true,
 * so activation was unreachable on every boot for months while every comment in
 * the tree said otherwise (#556); this admin shipped a comment saying App Check
 * was deferred and nothing else. Both survived because nothing anywhere could
 * answer "did attestation actually happen in this process?" with a value.
 *
 * So these assert the value, and they keep the three ways of NOT having
 * attestation apart:
 *
 *   Inactive    — never attempted
 *   Unsupported — deliberately skipped (a Robolectric run has no Play Services)
 *   Failed      — we tried and it broke
 *
 * Folding those together is what makes a broken attestation indistinguishable
 * from a deliberate skip.
 */
class AppCheckActivationTest {

    @Before fun setUp() = AppCheckActivation.resetForTest()

    @After fun tearDown() = AppCheckActivation.resetForTest()

    @Test
    fun `it starts inactive, so nothing can mistake "not asked yet" for attestation`() {
        assertEquals(AppCheckStatus.Inactive, AppCheckActivation.status)
    }

    @Test
    fun `installing the provider leaves it PENDING, not active`() = runBlocking {
        var installs = 0
        AppCheckActivation.activate(isRobolectric = false, install = { installs++ })

        // `pending`, not `active`: installing a factory returns immediately and
        // proves nothing. An unregistered app, a device without Play Services,
        // a Play Integrity API that is switched off — every real failure shows
        // up later, inside a token fetch.
        assertEquals(AppCheckStatus.Pending, AppCheckActivation.status)
        assertEquals(1, installs)
    }

    @Test
    fun `a real token turns it active`() = runBlocking {
        AppCheckActivation.activate(isRobolectric = false, install = {})
        AppCheckActivation.probe(fetchToken = { "a-real-app-check-token" })

        assertEquals(AppCheckStatus.Active, AppCheckActivation.status)
    }

    @Test
    fun `a token fetch that throws is FAILED, and failed is not inactive`() = runBlocking {
        AppCheckActivation.activate(isRobolectric = false, install = {})
        AppCheckActivation.probe(fetchToken = { throw IllegalStateException("app not registered") })

        // This is the state an unregistered `com.tribetails.auntieos` produces
        // today, and it has to be legible as such rather than as "we skipped it".
        assertEquals(AppCheckStatus.Failed, AppCheckActivation.status)
    }

    @Test
    fun `an empty token is a failure, not a success`() = runBlocking {
        AppCheckActivation.activate(isRobolectric = false, install = {})
        AppCheckActivation.probe(fetchToken = { "" })

        assertEquals(AppCheckStatus.Failed, AppCheckActivation.status)
    }

    @Test
    fun `an install that throws is FAILED and never probes`() = runBlocking {
        AppCheckActivation.activate(
            isRobolectric = false,
            install = { throw IllegalStateException("no FirebaseApp") },
        )
        assertEquals(AppCheckStatus.Failed, AppCheckActivation.status)

        var probed = false
        AppCheckActivation.probe(fetchToken = { probed = true; "t" })
        assertEquals(false, probed)
        assertEquals(AppCheckStatus.Failed, AppCheckActivation.status)
    }

    @Test
    fun `a Robolectric run is UNSUPPORTED and installs nothing`() {
        var installs = 0
        AppCheckActivation.activate(isRobolectric = true, install = { installs++ })

        assertEquals(AppCheckStatus.Unsupported, AppCheckActivation.status)
        assertEquals(0, installs)
    }

    @Test
    fun `it activates at most once per process`() {
        var installs = 0
        AppCheckActivation.activate(isRobolectric = false, install = { installs++ })
        AppCheckActivation.activate(isRobolectric = false, install = { installs++ })
        AppCheckActivation.activate(isRobolectric = false, install = { installs++ })

        assertEquals(1, installs)
    }
}
