package com.tribetails.auntieos.web.data

import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * #1066 on the desktop admin: the securetoken endpoint refusing a refresh because
 * the credential is dead (revoked, expired, user deleted or disabled).
 *
 * The desktop keeps its session in memory only, so it never meets a dead cached
 * credential at cold start the way the Android admin does; it meets one mid
 * session, at the next token refresh after a revocation. Before this, that
 * refusal went to Sentry and the operator stayed "signed in" with no token, so
 * every read failed. It is an expected auth state: end the session, say why on
 * the sign-in screen, and report nothing.
 */
class RefreshRejectionTest {

    private fun body(code: String) = """{"error":{"code":400,"message":"$code","status":"INVALID_ARGUMENT"}}"""

    @BeforeTest
    fun setUp() {
        SessionEndedNotice.clear()
        FirebaseRestAuth.authState.value = AuthUser(uid = "admin-1", email = "admin@example.com")
    }

    @AfterTest
    fun tearDown() {
        SessionEndedNotice.clear()
        FirebaseRestAuth.authState.value = null
    }

    @Test fun deadCredentialCodesEndTheSession() {
        assertEquals(SessionEndedReason.Revoked, refreshRejectionReason(body("TOKEN_EXPIRED")))
        assertEquals(SessionEndedReason.Revoked, refreshRejectionReason(body("INVALID_REFRESH_TOKEN")))
        assertEquals(SessionEndedReason.Revoked, refreshRejectionReason(body("USER_NOT_FOUND")))
        assertEquals(SessionEndedReason.Disabled, refreshRejectionReason(body("USER_DISABLED")))
    }

    @Test fun otherRefusalsAreNotASessionEnd() {
        assertNull(refreshRejectionReason(body("PROJECT_NUMBER_MISMATCH")))
        assertNull(refreshRejectionReason("<html>502 Bad Gateway</html>"))
        assertNull(refreshRejectionReason(""))
    }

    @Test fun aDeadCredentialSignsOutAndLeavesANotice() = runBlocking {
        val reason = FirebaseRestAuth.endSessionIfCredentialDead(body("TOKEN_EXPIRED"))

        assertEquals(SessionEndedReason.Revoked, reason)
        // authState is what App.kt gates on: null is the sign-in screen.
        assertNull(FirebaseRestAuth.authState.value)
        assertEquals(sessionEndedMessage(SessionEndedReason.Revoked), SessionEndedNotice.consume())
    }

    @Test fun anOrdinaryRefusalLeavesTheSessionAlone() = runBlocking {
        val reason = FirebaseRestAuth.endSessionIfCredentialDead("<html>502 Bad Gateway</html>")

        assertNull(reason)
        assertNotNull(FirebaseRestAuth.authState.value)
        assertNull(SessionEndedNotice.consume())
    }
}
