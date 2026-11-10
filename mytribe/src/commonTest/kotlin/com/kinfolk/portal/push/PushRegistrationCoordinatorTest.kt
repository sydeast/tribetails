package com.kinfolk.portal.push

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.firebase.FunctionsClient
import kotlinx.serialization.json.JsonObject
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.awaitCancellation
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** A Functions client whose every call waits forever, to prove the register step is bounded. */
private class HangingFunctionsClient : FunctionsClient {
    override suspend fun call(name: String, payload: JsonObject?): JsonObject = awaitCancellation()
}
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

    // #1547: a failure line must say which stage failed and what threw, not
    // only the message, so a logcat line or a Sentry breadcrumb can be triaged.
    @Test
    fun `register failure logs the stage and the exception class, never only the message`() = runTest {
        val fake = fakeWithStubs()
        fake.stubError("registerFcmToken", IllegalStateException("network down"))
        val lines = mutableListOf<String>()
        val c = PushRegistrationCoordinator(
            portalApi = PortalApi(fake),
            platform = "test-mytribe",
            tokenProvider = { "tok-1" },
            logger = { lines += it },
        )
        c.onSignedIn()
        assertEquals(listOf("register failed: IllegalStateException: network down"), lines)
    }

    @Test
    fun `token provider failure logs the token stage and the exception class`() = runTest {
        val fake = fakeWithStubs()
        val lines = mutableListOf<String>()
        val c = PushRegistrationCoordinator(
            portalApi = PortalApi(fake),
            platform = "test-mytribe",
            tokenProvider = { throw UnsupportedOperationException("permission API exploded") },
            logger = { lines += it },
        )
        c.onSignedIn()
        assertEquals(listOf("token failed: UnsupportedOperationException: permission API exploded"), lines)
    }

    @Test
    fun `unregister failure logs the unregister stage and never the token value`() = runTest {
        val fake = fakeWithStubs()
        val lines = mutableListOf<String>()
        val c = PushRegistrationCoordinator(
            portalApi = PortalApi(fake),
            platform = "test-mytribe",
            tokenProvider = { "tok-secret" },
            logger = { lines += it },
        )
        c.onSignedIn()
        fake.stubError("unregisterFcmToken", IllegalStateException("auth already torn down"))
        c.onSignOut()
        assertEquals(listOf("unregister failed: IllegalStateException: auth already torn down"), lines)
        assertTrue(lines.none { it.contains("tok-secret") })
    }

    // #1547 (b): a step that never answers ends in a named log line, not a hang.
    @Test
    fun `token provider that never answers logs a token timeout and registers nothing`() = runTest {
        val fake = fakeWithStubs()
        val lines = mutableListOf<String>()
        val c = PushRegistrationCoordinator(
            portalApi = PortalApi(fake),
            platform = "test-mytribe",
            tokenProvider = { awaitCancellation() },
            logger = { lines += it },
            stepTimeoutMs = 1_000,
        )
        c.onSignedIn()
        assertEquals(1, lines.size)
        assertTrue(lines[0].startsWith("token failed: TimeoutCancellationException"), lines[0])
        assertEquals(0, fake.calls.size)
        assertNull(c.registeredToken)
    }
    @Test
    fun `register call that never answers logs a register timeout and caches nothing`() = runTest {
        val lines = mutableListOf<String>()
        val c = PushRegistrationCoordinator(
            portalApi = PortalApi(HangingFunctionsClient()),
            platform = "test-mytribe",
            tokenProvider = { "tok-1" },
            logger = { lines += it },
            stepTimeoutMs = 1_000,
        )
        c.onSignedIn()
        assertEquals(1, lines.size)
        assertTrue(lines[0].startsWith("register failed: TimeoutCancellationException"), lines[0])
        assertNull(c.registeredToken)
    }
    @Test
    fun `a cancelled scope still propagates and is not logged as a failure`() = runTest {
        val fake = fakeWithStubs()
        val lines = mutableListOf<String>()
        val c = PushRegistrationCoordinator(
            portalApi = PortalApi(fake),
            platform = "test-mytribe",
            tokenProvider = { throw CancellationException("scope closed") },
            logger = { lines += it },
        )
        var propagated = false
        try {
            c.onSignedIn()
        } catch (e: CancellationException) {
            propagated = true
        }
        assertTrue(propagated)
        assertTrue(lines.isEmpty())
    }

    // ---- #1787: the device's own state and Retry ----
    @Test
    fun `state is Unknown before any attempt and Registered after a good sign-in`() = runTest {
        val c = coordinator(fakeWithStubs())
        assertEquals(DevicePushState.Unknown, c.state.value)
        c.onSignedIn()
        assertEquals(DevicePushState.Registered, c.state.value)
    }
    @Test
    fun `a clean null token is Unavailable, not a failure`() = runTest {
        val c = coordinator(fakeWithStubs(), token = null)
        c.onSignedIn()
        assertEquals(DevicePushState.Unavailable, c.state.value)
    }
    @Test
    fun `a token fetch that throws is Failed at the token stage with the class and message`() = runTest {
        val c = PushRegistrationCoordinator(
            portalApi = PortalApi(fakeWithStubs()),
            platform = "test-mytribe",
            tokenProvider = { throw IllegalStateException("SERVICE_NOT_AVAILABLE") },
            logger = {},
        )
        c.onSignedIn()
        assertEquals(DevicePushState.Failed("token", "IllegalStateException: SERVICE_NOT_AVAILABLE"), c.state.value)
    }
    @Test
    fun `a register failure is Failed at the register stage and never carries the token`() = runTest {
        val fake = fakeWithStubs()
        fake.stubError("registerFcmToken", IllegalStateException("network down"))
        val c = coordinator(fake, token = "secret-token-value")
        c.onSignedIn()
        val state = c.state.value
        assertTrue(state is DevicePushState.Failed && state.stage == "register")
        assertTrue(!state.toString().contains("secret-token-value"))
    }
    @Test
    fun `retry registers again after a failure and the state turns Registered`() = runTest {
        val fake = fakeWithStubs()
        var failFirst = true
        val c = PushRegistrationCoordinator(
            portalApi = PortalApi(fake),
            platform = "test-mytribe",
            tokenProvider = {
                if (failFirst) { failFirst = false; throw IllegalStateException("boom") }
                "tok-1"
            },
            logger = {},
        )
        c.onSignedIn()
        assertTrue(c.state.value is DevicePushState.Failed)
        assertEquals(0, fake.calls.size)
        c.retry()
        assertEquals(DevicePushState.Registered, c.state.value)
        assertEquals(1, fake.calls.size)
    }
    @Test
    fun `retry re-sends the register call even when a token was already registered`() = runTest {
        val fake = fakeWithStubs()
        val c = coordinator(fake)
        c.onSignedIn()
        c.retry()
        assertEquals(2, fake.calls.size)
        assertEquals(DevicePushState.Registered, c.state.value)
    }
    @Test
    fun `retry that fails again stays Failed and a later clean null clears the stale failure`() = runTest {
        val fake = fakeWithStubs()
        fake.stubError("registerFcmToken", IllegalStateException("network down"))
        var token: String? = "tok-1"
        val c = PushRegistrationCoordinator(
            portalApi = PortalApi(fake), platform = "test-mytribe", tokenProvider = { token }, logger = {},
        )
        c.onSignedIn()
        c.retry()
        assertTrue(c.state.value is DevicePushState.Failed)
        token = null
        c.retry()
        assertEquals(DevicePushState.Unavailable, c.state.value)
    }
    @Test
    fun `sign-out resets the state to Unknown`() = runTest {
        val c = coordinator(fakeWithStubs())
        c.onSignedIn()
        c.onSignOut()
        assertEquals(DevicePushState.Unknown, c.state.value)
    }
    @Test
    fun `an unregister failure on sign-out does not show as a device failure`() = runTest {
        val fake = fakeWithStubs()
        val c = coordinator(fake)
        c.onSignedIn()
        fake.stubError("unregisterFcmToken", IllegalStateException("offline"))
        c.onSignOut()
        assertEquals(DevicePushState.Unknown, c.state.value)
    }
}
