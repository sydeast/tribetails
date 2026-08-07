package com.kinfolk.portal.launch

import com.kinfolk.portal.auth.AuthState
import com.kinfolk.portal.portal.MyAccessResult
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class LaunchRouterTest {

    @Test
    fun loading_returnsNull() {
        val d = resolveLaunchDestination(AuthState.Loading, null, null)
        assertNull(d)
    }

    @Test
    fun signedOut_routesToSignIn() {
        val d = resolveLaunchDestination(AuthState.SignedOut, null, null)
        assertEquals(LaunchDestination.SignIn, d)
    }

    @Test
    fun signedIn_butAccessNotYetResolved_returnsNull() {
        val d = resolveLaunchDestination(AuthState.SignedIn("u1", null, null), null, null)
        assertNull(d, "while access call in flight, dest should remain null")
    }

    @Test
    fun signedIn_accessError_routesToError() {
        val d = resolveLaunchDestination(AuthState.SignedIn("u1", null, null), null, "boom")
        assertTrue(d is LaunchDestination.Error)
        assertEquals("boom", (d as LaunchDestination.Error).message)
    }

    @Test
    fun signedIn_emptyKinfolks_nonOperator_routesToNoTribes() {
        val d = resolveLaunchDestination(
            AuthState.SignedIn("u1", null, null),
            MyAccessResult(kinfolkIds = emptyList(), isOperator = false),
            null,
        )
        assertEquals(LaunchDestination.NoTribes, d)
    }

    @Test
    fun signedIn_oneKinfolk_nonOperator_routesToHome() {
        val d = resolveLaunchDestination(
            AuthState.SignedIn("u1", null, null),
            MyAccessResult(kinfolkIds = listOf("3"), isOperator = false),
            null,
        )
        assertEquals(LaunchDestination.Home("3"), d)
    }

    // Operator ruling 2026-08-06, "one kinfolk, one tribe": a non-operator with
    // 2+ ids can no longer happen legitimately. It's a data defect, and the
    // fail-loud rule says a defect is surfaced, not absorbed: not the picker
    // (its existence for non-operators is what the ruling withdrew) and not
    // an auto-pick into Home (that would show a random household's data).
    @Test
    fun signedIn_multipleKinfolks_nonOperator_routesToError_notPick_notHome() {
        val d = resolveLaunchDestination(
            AuthState.SignedIn("u1", null, null),
            MyAccessResult(kinfolkIds = listOf("3", "5"), isOperator = false),
            null,
        )
        assertTrue(d is LaunchDestination.Error, "expected Error, got $d")
        val message = (d as LaunchDestination.Error).message
        assertTrue(message.contains("2"), "message should name the tribe count: $message")
    }

    @Test
    fun signedIn_operatorWithSingleId_stillRoutesToPick_notHome() {
        // Operators always see the directory, even when their own kinfolkIds set is small.
        val d = resolveLaunchDestination(
            AuthState.SignedIn("op", null, null),
            MyAccessResult(kinfolkIds = listOf("3"), isOperator = true),
            null,
        )
        assertTrue(d is LaunchDestination.Pick)
        assertEquals(true, (d as LaunchDestination.Pick).isOperator)
    }

    @Test
    fun signedIn_operatorFive_routesToPickOperator_withAllFiveListed() {
        val d = resolveLaunchDestination(
            AuthState.SignedIn("op", null, null),
            MyAccessResult(kinfolkIds = listOf("3", "5", "7", "9", "11"), isOperator = true),
            null,
        )
        assertTrue(d is LaunchDestination.Pick)
        val pick = d as LaunchDestination.Pick
        assertEquals(true, pick.isOperator)
        assertEquals(listOf("3", "5", "7", "9", "11"), pick.kinfolkIds)
    }

    @Test
    fun signedIn_operatorWithNoIds_routesToNoTribes() {
        // Edge case: operator UID set but kinfolk collection empty.
        val d = resolveLaunchDestination(
            AuthState.SignedIn("op", null, null),
            MyAccessResult(kinfolkIds = emptyList(), isOperator = true),
            null,
        )
        assertEquals(LaunchDestination.NoTribes, d)
    }
}
