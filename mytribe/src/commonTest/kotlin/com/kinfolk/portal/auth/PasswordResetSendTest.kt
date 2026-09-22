package com.kinfolk.portal.auth

import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #911: the reset send on portal Android and portal desktop moved off the
 * `requestPasswordReset` callable, which answered `{ ok: true }` for every
 * address, and onto Firebase's own reset, which refuses an address it has
 * never seen unless the project's email enumeration protection is on.
 *
 * These pin the one rule that closes the difference: an unknown account is the
 * only failure [AuthRepository.sendPasswordReset] absorbs, and it absorbs it
 * whichever of the three SDK spellings arrives.
 */
class PasswordResetSendTest {

    @Test
    fun everySdkSpellingOfNoSuchAccountIsRecognised() {
        for (code in listOf("auth/user-not-found", "ERROR_USER_NOT_FOUND", "EMAIL_NOT_FOUND")) {
            assertTrue(isUnknownAccountOnReset(code, null), "expected $code to read as an unknown account")
        }
    }

    /** The desktop failure arrives as an Identity Toolkit body, not a bare code. */
    @Test
    fun theIdentityToolkitBodyIsRecognisedWithNoCodeAtAll() {
        assertTrue(
            isUnknownAccountOnReset(null, """{"error":{"code":400,"message":"EMAIL_NOT_FOUND"}}"""),
        )
    }

    @Test
    fun nothingElseIsTreatedAsAnUnknownAccount() {
        val others = listOf(
            "auth/invalid-email" to "The email address is badly formatted.",
            "auth/too-many-requests" to "We have blocked all requests from this device.",
            "INVALID_EMAIL" to """{"error":{"message":"INVALID_EMAIL"}}""",
            "TOO_MANY_ATTEMPTS_TRY_LATER" to """{"error":{"message":"TOO_MANY_ATTEMPTS_TRY_LATER"}}""",
            "ERROR_USER_DISABLED" to "The user account has been disabled.",
        )
        for ((code, text) in others) {
            assertFalse(isUnknownAccountOnReset(code, text), "$code must keep its own message")
        }
        assertFalse(isUnknownAccountOnReset(null, "connection reset by peer"))
        assertFalse(isUnknownAccountOnReset(null, null))
    }

    @Test
    fun anUnknownAccountReadsTheSameAsARealOne() = runTest {
        val sent = mutableListOf<String>()
        val real = AuthRepository(
            StubResetBackend { sent += it },
        )
        real.sendPasswordReset("pat@household.test")

        val unknown = AuthRepository(
            StubResetBackend { throw IllegalStateException("auth/user-not-found") },
        )
        // No throw is the whole assertion: the screen shows "Reset link sent"
        // for an address that is not an account, exactly as it did when the
        // callable answered { ok: true } for one.
        unknown.sendPasswordReset("ghost@household.test")

        assertEquals(listOf("pat@household.test"), sent)
    }

    @Test
    fun aRealSendFailureStillReachesTheScreen() = runTest {
        val repo = AuthRepository(
            StubResetBackend { throw IllegalStateException("auth/too-many-requests") },
        )
        val thrown = assertFailsWith<IllegalStateException> { repo.sendPasswordReset("pat@household.test") }
        assertEquals("auth/too-many-requests", thrown.message)
    }
}

private class StubResetBackend(
    private val onSend: (String) -> Unit,
) : AuthBackend by FakeAuthBackend() {
    override suspend fun sendPasswordReset(email: String, continueUrl: String?) = onSend(email)
}
