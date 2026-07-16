package com.kinfolk.portal.push

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class PushRegistrationCoordinatorTest {

    private fun fakeWithStubs(): FakeFunctionsClient = FakeFunctionsClient().apply {
        stub("registerFcmToken", buildJsonObject {})
        stub("unregisterFcmToken", buildJsonObject {})
    }

    private fun coordinator(
        fake: FakeFunctionsClient,
        token: String? = "tok-1",
    ) = PushRegistrationCoordinator(
        portalApi = PortalApi(fake),
        platform = "test-mytribe",
        tokenProvider = { token },
    )

    @Test
    fun `registers token with platform on sign-in`() = runTest {
        val fake = fakeWithStubs()
        val c = coordinator(fake)
        c.onSignedIn()
        assertEquals(1, fake.calls.size)
        assertEquals("registerFcmToken", fake.calls[0].first)
        val payload = fake.calls[0].second!!
        assertEquals("tok-1", payload["token"]?.jsonPrimitive?.contentOrNull)
        assertEquals("test-mytribe", payload["platform"]?.jsonPrimitive?.contentOrNull)
        assertEquals("tok-1", c.registeredToken)
    }

    @Test
    fun `skips registration when token provider returns null`() = runTest {
        val fake = fakeWithStubs()
        val c = coordinator(fake, token = null)
        c.onSignedIn()
        assertEquals(0, fake.calls.size)
        assertNull(c.registeredToken)
    }

    @Test
    fun `skips registration when token provider throws`() = runTest {
        val fake = fakeWithStubs()
        val c = PushRegistrationCoordinator(
            portalApi = PortalApi(fake),
            platform = "test-mytribe",
            tokenProvider = { error("permission API exploded") },
        )
        c.onSignedIn() // must not throw
        assertEquals(0, fake.calls.size)
        assertNull(c.registeredToken)
    }

    @Test
    fun `does not double-register the same token across repeated sign-in emissions`() = runTest {
        val fake = fakeWithStubs()
        val c = coordinator(fake)
        c.onSignedIn()
        c.onSignedIn()
        c.onSignedIn()
        assertEquals(1, fake.calls.size)
    }

    @Test
    fun `registers replacement token on refresh and skips a same-token refresh`() = runTest {
        val fake = fakeWithStubs()
        val c = coordinator(fake)
        c.onSignedIn()
        c.onTokenRefreshed("tok-1") // same → skipped
        c.onTokenRefreshed("tok-2") // new → registered
        assertEquals(2, fake.calls.size)
        assertEquals("tok-2", fake.calls[1].second!!["token"]?.jsonPrimitive?.contentOrNull)
        assertEquals("tok-2", c.registeredToken)
    }

    @Test
    fun `unregisters the registered token on sign-out and forgets it`() = runTest {
        val fake = fakeWithStubs()
        val c = coordinator(fake)
        c.onSignedIn()
        c.onSignOut()
        assertEquals(2, fake.calls.size)
        assertEquals("unregisterFcmToken", fake.calls[1].first)
        assertEquals("tok-1", fake.calls[1].second!!["token"]?.jsonPrimitive?.contentOrNull)
        assertNull(c.registeredToken)
    }

    @Test
    fun `sign-out without a registered token makes no Functions call`() = runTest {
        val fake = fakeWithStubs()
        val c = coordinator(fake, token = null)
        c.onSignedIn()
        c.onSignOut()
        assertEquals(0, fake.calls.size)
    }

    @Test
    fun `register failure is swallowed and leaves no cached token so a later sign-in retries`() = runTest {
        val fake = fakeWithStubs()
        fake.stubError("registerFcmToken", IllegalStateException("network down"))
        val c = coordinator(fake)
        c.onSignedIn() // must not throw
        assertNull(c.registeredToken)
        c.onSignedIn() // still failing, but proves it RETRIES rather than caching the failure
        assertEquals(2, fake.calls.size)
        assertNull(c.registeredToken)
    }

    @Test
    fun `unregister failure is swallowed and the token stays forgotten`() = runTest {
        val fake = fakeWithStubs()
        val c = coordinator(fake)
        c.onSignedIn()
        fake.stubError("unregisterFcmToken", IllegalStateException("auth already torn down"))
        c.onSignOut() // must not throw
        assertNull(c.registeredToken)
        // a fresh sign-in re-registers from scratch
        c.onSignedIn()
        assertEquals("tok-1", c.registeredToken)
    }

    @Test
    fun `re-registers after a sign-out and sign-in cycle`() = runTest {
        val fake = fakeWithStubs()
        val c = coordinator(fake)
        c.onSignedIn()
        c.onSignOut()
        c.onSignedIn()
        assertEquals(3, fake.calls.size)
        assertEquals("registerFcmToken", fake.calls[2].first)
    }
}
