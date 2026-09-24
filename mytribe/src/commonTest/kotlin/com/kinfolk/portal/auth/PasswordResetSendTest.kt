package com.kinfolk.portal.auth

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #905: portal Android and portal desktop send resets through our own
 * `requestPasswordReset` callable again, as portal web now does too. It
 * answers `{ ok: true }` for every address, so [AuthRepository.sendPasswordReset]
 * absorbs nothing and passes the address alone.
 *
 * These pin the two rules the screens rely on: a refusal by the callable's
 * per-IP limit is recognised in every spelling a client carries it in, and
 * nothing else is mistaken for it.
 */
class PasswordResetSendTest {

    @Test
    fun everySpellingOfThePerIpLimitIsRecognised() {
        val spellings = listOf(
            // Android's native SDK and the JS SDK: the server's own message.
            "Too many requests. Try again later.",
            // Desktop: FirebaseRestException's message carries the REST body.
            """Firebase REST sendPasswordReset failed: HTTP 429 — {"error":{"message":"Too many requests. Try again later.","status":"RESOURCE_EXHAUSTED"}}""",
            // The web SDK's code, in case a wrapper surfaces it as text.
            "FirebaseError: functions/resource-exhausted",
            // lib/rateLimit.ts's wording, the other rate-limit sentence the backend uses.
            "Too many attempts. Try again later.",
        )
        for (text in spellings) {
            assertTrue(isResetRateLimited(text), "expected a rate limit in: $text")
            assertTrue(isResetRateLimited(RuntimeException(text)), "expected a rate limit in a throwable of: $text")
        }
    }

    @Test
    fun nothingElseIsTreatedAsTheLimit() {
        val others = listOf(
            "INTERNAL",
            "email (valid email address) is required",
            """Firebase REST sendPasswordReset failed: HTTP 400 — {"error":{"message":"email (valid email address) is required","status":"INVALID_ARGUMENT"}}""",
            "connection reset by peer",
            "auth/too-many-requests",
        )
        for (text in others) {
            assertFalse(isResetRateLimited(text), "$text must keep the plain failure message")
        }
        assertFalse(isResetRateLimited(null as String?))
    }

    @Test
    fun theAddressIsTheWholeRequest() = runTest {
        val sent = mutableListOf<String>()
        val repo = AuthRepository(StubResetBackend { sent += it })
        repo.sendPasswordReset("pat@household.test")
        assertEquals(listOf("pat@household.test"), sent)
    }

    /**
     * No failure is absorbed any more. Before #905 an unknown account's
     * `auth/user-not-found` was swallowed here because Firebase's reset refused
     * addresses it had never seen; the callable never does.
     */
    @Test
    fun everyFailureReachesTheScreen() = runTest {
        for (message in listOf("auth/user-not-found", "Too many requests. Try again later.", "socket closed")) {
            val repo = AuthRepository(StubResetBackend { throw IllegalStateException(message) })
            val thrown = assertFailsWith<IllegalStateException> { repo.sendPasswordReset("pat@household.test") }
            assertEquals(message, thrown.message)
        }
    }

    @Test
    fun theRateLimitCopyMatchesTheClaimCardAndPortalWeb() {
        assertEquals("Too many tries for now. Wait a few minutes, then try again.", RESET_RATE_LIMITED_MESSAGE)
        assertEquals(com.kinfolk.portal.screens.claim.CLAIM_RATE_LIMITED_MESSAGE, RESET_RATE_LIMITED_MESSAGE)
    }
}

private class StubResetBackend(
    private val onSend: (String) -> Unit,
) : AuthBackend by FakeAuthBackend() {
    override suspend fun sendPasswordReset(email: String) = onSend(email)
}
