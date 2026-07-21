package com.tribetails.auntieos.web.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Unit tests for [friendlyAuthError] and [AuthOpResult] (spec 29 item 15.4): each
 * Firebase Auth error code maps to clear operator-facing copy, and unknown codes
 * degrade without crashing.
 */
class FriendlyAuthErrorTest {

    @Test
    fun wrongPasswordIsClear() {
        assertTrue(friendlyAuthError("auth/wrong-password").contains("Current password is incorrect"))
        assertEquals(friendlyAuthError("auth/wrong-password"), friendlyAuthError("auth/invalid-credential"))
    }

    @Test
    fun requiresRecentLoginAsksToReauth() {
        assertTrue(friendlyAuthError("auth/requires-recent-login").contains("sign in again"))
    }

    @Test
    fun emailInUseAndWeakPassword() {
        assertTrue(friendlyAuthError("auth/email-already-in-use").contains("already in use"))
        assertTrue(friendlyAuthError("auth/weak-password").contains("stronger"))
    }

    @Test
    fun unknownCodeIsSurfacedNotSwallowed() {
        assertTrue(friendlyAuthError("auth/something-new").contains("auth/something-new"))
    }

    @Test
    fun failureResultExposesFriendly() {
        val f = AuthOpResult.Failure("auth/no-current-user")
        assertTrue(f.friendly.contains("Sign in again"))
    }
}
