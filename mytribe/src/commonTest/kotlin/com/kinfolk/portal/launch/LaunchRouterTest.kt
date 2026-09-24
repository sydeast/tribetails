package com.kinfolk.portal.launch

import com.kinfolk.portal.auth.AuthBackend
import com.kinfolk.portal.auth.AuthProviderId
import com.kinfolk.portal.auth.AuthRepository
import com.kinfolk.portal.auth.AuthState
import com.kinfolk.portal.portal.MyAccessResult
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
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

    /**
     * #494. "We could not check" is not "you are signed out", and it must not
     * land on the sign-in screen: to the kinfolk that reads as having been
     * logged out of an app they never left. The launch error screen is where it
     * goes, because that screen already offers Retry (which re-runs refresh)
     * and Sign out for anybody who did mean to leave.
     */
    @Test
    fun unreachable_routesToRetryableError_notSignIn() {
        val d = resolveLaunchDestination(AuthState.Unreachable("Failed to fetch"), null, null)
        assertTrue(d is LaunchDestination.Error)
        assertEquals(COULD_NOT_CHECK_SIGN_IN, (d as LaunchDestination.Error).message)
    }
    /** The backend's own words stay in the log; the screen gets a sentence. */
    @Test
    fun unreachable_doesNotPutTheRawFailureOnScreen() {
        val d = resolveLaunchDestination(AuthState.Unreachable("NSURLErrorDomain -1009"), null, null)
        assertTrue(d is LaunchDestination.Error)
        assertTrue(!(d as LaunchDestination.Error).message.contains("NSURLError"))
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

/**
 * THE OTHER HALF OF #502, JOINED UP.
 *
 * `AuthRepositoryObserveTest` proves a mid-session transition reaches
 * `repo.state`. That on its own is not the thing the issue asked for: a state
 * nothing re-reads is still invisible to whoever is sitting in front of the
 * screen. What makes it visible is that `rememberLaunchDestination` collects
 * `repo.state` with `collectAsState` and recomputes `resolveLaunchDestination`
 * on every recomposition, so a new auth state is a new destination without
 * anything else having to notice.
 *
 * These tests bind the two halves without a Compose runtime: emit through the
 * backend's flow, read `repo.state`, and route it exactly as the composable
 * does. Together with the collectAsState above, that is the whole path from
 * "the session ended" to "the screen changed".
 */
class MidSessionAuthChangeRoutingTest {
    private class FlowBackend(private val states: Flow<AuthState>) : AuthBackend {
        override suspend fun currentUser(): AuthState = AuthState.SignedOut
        override fun authStateChanges(): Flow<AuthState> = states
        override suspend fun signInWithEmailPassword(email: String, password: String) =
            AuthState.SignedIn("u1", email, null)
        override suspend fun signInWithCustomToken(token: String) = AuthState.SignedIn("u1", null, null)
        override suspend fun sendMagicLink(email: String) = Unit
        override suspend fun signInWithMagicLink(email: String, link: String) =
            AuthState.SignedIn("u1", email, null)
        override suspend fun signInWithIdToken(provider: AuthProviderId, idToken: String, rawNonce: String?) =
            AuthState.SignedIn("u1", null, null)
        override suspend fun signInWithPhoneOtp(verificationId: String, smsCode: String) =
            AuthState.SignedIn("u1", null, null)
        override suspend fun signOut() = Unit
        override suspend fun sendPasswordReset(email: String) = Unit
        override suspend fun changePassword(currentPassword: String, newPassword: String) = Unit
        override suspend fun changeEmail(currentPassword: String, newEmail: String) = Unit
    }
    private val access = MyAccessResult(kinfolkIds = listOf("k1"), isOperator = false)
    @Test
    fun revokedMidVisit_takesTheKinfolkFromHomeToSignIn() = runTest {
        val states = MutableSharedFlow<AuthState>(extraBufferCapacity = 8)
        val repo = AuthRepository(FlowBackend(states))
        val job = launch { repo.observe() }
        runCurrent()
        states.emit(AuthState.SignedIn("u1", "kin@example.com", null))
        runCurrent()
        assertEquals(
            LaunchDestination.Home("k1"),
            resolveLaunchDestination(repo.state.value, access, null),
            "signed in with one household lands on Home",
        )
        // The session ends somewhere else: revoked by the operator, signed out
        // on another device. Nothing in this app was asked anything.
        states.emit(AuthState.SignedOut)
        runCurrent()
        assertEquals(
            LaunchDestination.SignIn,
            resolveLaunchDestination(repo.state.value, null, null),
            "a session that ended mid-visit has to leave the household's screen",
        )
        job.cancel()
    }
    /**
     * And the failure mode #494 fixed does not come back through this door: a
     * subscription that dies is Unreachable, so it routes to the retryable
     * launch error, not to the sign-in screen.
     */
    @Test
    fun subscriptionDies_routesToRetryableError_notSignIn() = runTest {
        val states = MutableSharedFlow<AuthState>(extraBufferCapacity = 8)
        val repo = AuthRepository(FlowBackend(states))
        val job = launch { repo.observe() }
        runCurrent()
        states.emit(AuthState.SignedIn("u1", null, null))
        runCurrent()
        job.cancel()
        val broken = AuthRepository(FlowBackend(kotlinx.coroutines.flow.flow {
            emit(AuthState.SignedIn("u1", null, null))
            throw RuntimeException("stream died")
        }))
        broken.observe()
        val d = resolveLaunchDestination(broken.state.value, null, null)
        assertTrue(d is LaunchDestination.Error)
        assertEquals(COULD_NOT_CHECK_SIGN_IN, (d as LaunchDestination.Error).message)
    }
}
