package com.kinfolk.portal.firebase

import com.kinfolk.portal.auth.SessionEndedNotice
import com.kinfolk.portal.portal.PortalApi
import kotlin.coroutines.cancellation.CancellationException
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * #557, on the client. Proves the reproduction — a callable refused because the
 * session was revoked signs the kinfolk out — and, just as importantly, that
 * nothing else does.
 */
class RevocationAwareFunctionsClientTest {

    private val revoked = RuntimeException("Your session was ended (session-revoked). Sign in again.")

    @AfterTest
    fun tearDown() {
        SessionEndedNotice.clear()
    }

    private class RecordingSignOut {
        var count = 0
        val block: suspend () -> Unit = { count++ }
    }

    @Test
    fun a_revoked_token_ends_the_local_session() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyHome", revoked)
        val signOut = RecordingSignOut()
        val client = RevocationAwareFunctionsClient(fake, signOut.block)

        assertFailsWith<RuntimeException> { client.call("getMyHome", null) }

        assertEquals(1, signOut.count)
        assertNotNull(SessionEndedNotice.consume())
    }

    @Test
    fun a_valid_call_still_passes_through_untouched() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyHome", buildJsonObject { put("displayName", "The Ruiz Tribe") })
        val signOut = RecordingSignOut()
        val client = RevocationAwareFunctionsClient(fake, signOut.block)

        val result = client.call("getMyHome", null)

        assertEquals("The Ruiz Tribe", result["displayName"]?.toString()?.trim('"'))
        assertEquals(0, signOut.count)
        assertNull(SessionEndedNotice.consume())
    }

    @Test
    fun the_refusal_is_rethrown_so_the_screen_still_handles_it() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyHome", revoked)
        val client = RevocationAwareFunctionsClient(fake) { }

        val thrown = assertFailsWith<RuntimeException> { client.call("getMyHome", null) }

        assertTrue(thrown.message!!.contains("session-revoked"))
    }

    @Test
    fun a_burst_of_refusals_signs_out_once() = runTest {
        val fake = FakeFunctionsClient()
        // A screen load: several callables in flight, every one of them refused.
        for (name in listOf("getMyHome", "getMyKin", "getMyInvoices", "getMyNotifications")) {
            fake.stubError(name, revoked)
        }
        val signOut = RecordingSignOut()
        val client = RevocationAwareFunctionsClient(fake, signOut.block)

        val attempts = listOf("getMyHome", "getMyKin", "getMyInvoices", "getMyNotifications").map {
            async { runCatching { client.call(it, null) } }
        }
        attempts.awaitAll()

        assertEquals(1, signOut.count)
    }

    /**
     * The guard collapses ONE burst, it does not latch for the life of the
     * process. This client is remembered for as long as the app is composed, so
     * a latch would mean: revoked once, signed back in, revoked again weeks
     * later, and nothing happens the second time. That is the failure this
     * class exists to prevent, arriving through the fix for it.
     */
    @Test
    fun a_second_revocation_after_signing_back_in_still_signs_out() = runTest {
        val fake = FakeFunctionsClient()
        val signOut = RecordingSignOut()
        val client = RevocationAwareFunctionsClient(fake, signOut.block)

        fake.stubError("getMyHome", revoked)
        assertFailsWith<RuntimeException> { client.call("getMyHome", null) }
        assertEquals(1, signOut.count)

        // Signed back in on the same install: calls work again.
        fake.stub("getMyHome", buildJsonObject { put("displayName", "The Ruiz Tribe") })
        client.call("getMyHome", null)

        // And that session is revoked too.
        fake.stubError("getMyHome", revoked)
        assertFailsWith<RuntimeException> { client.call("getMyHome", null) }

        assertEquals(2, signOut.count)
        assertNotNull(SessionEndedNotice.consume())
    }

    @Test
    fun permission_denied_does_not_sign_anyone_out() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyKinPhotos", IllegalStateException("permission-denied: not your family"))
        val signOut = RecordingSignOut()
        val client = RevocationAwareFunctionsClient(fake, signOut.block)

        assertFailsWith<IllegalStateException> { client.call("getMyKinPhotos", null) }

        assertEquals(0, signOut.count)
        assertNull(SessionEndedNotice.consume())
    }

    @Test
    fun a_network_failure_does_not_sign_anyone_out() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyHome", RuntimeException("Failed to fetch"))
        val signOut = RecordingSignOut()
        val client = RevocationAwareFunctionsClient(fake, signOut.block)

        assertFailsWith<RuntimeException> { client.call("getMyHome", null) }

        assertEquals(0, signOut.count)
    }

    @Test
    fun a_cancelled_call_is_not_treated_as_a_revoked_session() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyHome", CancellationException("screen left"))
        val signOut = RecordingSignOut()
        val client = RevocationAwareFunctionsClient(fake, signOut.block)

        assertFailsWith<CancellationException> { client.call("getMyHome", null) }

        assertEquals(0, signOut.count)
    }

    @Test
    fun a_failing_sign_out_does_not_swallow_the_original_refusal() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyHome", revoked)
        val client = RevocationAwareFunctionsClient(fake) { error("sign-out itself failed") }

        val thrown = assertFailsWith<RuntimeException> { client.call("getMyHome", null) }

        assertTrue(thrown.message!!.contains("session-revoked"))
    }

    /**
     * The decorator sits UNDER `PortalApi`, so every one of its ~120 methods is
     * covered without any of them knowing. Pinning one of them proves the
     * layering, which is the whole reason the reaction lives here rather than
     * in each screen's catch.
     */
    @Test
    fun the_reaction_covers_PortalApi_calls_without_PortalApi_knowing() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyAccess", revoked)
        val signOut = RecordingSignOut()
        val api = PortalApi(RevocationAwareFunctionsClient(fake, signOut.block))

        assertFailsWith<RuntimeException> { api.getMyAccess() }

        assertEquals(1, signOut.count)
    }
}
