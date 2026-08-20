package com.kinfolk.portal.auth

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

private class StubBackend(
    private val onCurrent: suspend () -> AuthState = { AuthState.SignedOut },
    private val onPwSignIn: suspend (String, String) -> AuthState.SignedIn = { e, _ ->
        AuthState.SignedIn("uid-$e", e, null)
    },
    private val onMagicSend: suspend (String) -> Unit = {},
    private val onMagicComplete: suspend (String, String) -> AuthState.SignedIn = { e, _ ->
        AuthState.SignedIn("uid-$e", e, null)
    },
    private val onIdToken: suspend (AuthProviderId, String, String?) -> AuthState.SignedIn = { _, _, _ ->
        AuthState.SignedIn("uid-id", null, null)
    },
    private val onPhone: suspend (String, String) -> AuthState.SignedIn = { _, _ ->
        AuthState.SignedIn("uid-ph", null, null)
    },
    private val onSignOut: suspend () -> Unit = {},
    private val onPasswordReset: suspend (String) -> Unit = {},
    private val states: Flow<AuthState>? = null,
) : AuthBackend {
    var signOutCount = 0
    var magicSendCount = 0
    var passwordResetCount = 0
    var lastPasswordResetEmail: String? = null
    var refreshIdTokenCount = 0

    override suspend fun currentUser(): AuthState = onCurrent()
    override suspend fun signInWithEmailPassword(email: String, password: String) =
        onPwSignIn(email, password)
    override suspend fun signInWithCustomToken(token: String) =
        onPwSignIn("custom-token", token)
    override suspend fun sendMagicLink(email: String) {
        magicSendCount++; onMagicSend(email)
    }
    override suspend fun signInWithMagicLink(email: String, link: String) =
        onMagicComplete(email, link)
    override suspend fun signInWithIdToken(provider: AuthProviderId, idToken: String, rawNonce: String?) =
        onIdToken(provider, idToken, rawNonce)
    override suspend fun signInWithPhoneOtp(verificationId: String, smsCode: String) =
        onPhone(verificationId, smsCode)
    override suspend fun signOut() {
        signOutCount++; onSignOut()
    }
    override suspend fun sendPasswordReset(email: String) {
        passwordResetCount++
        lastPasswordResetEmail = email
        onPasswordReset(email)
    }
    override suspend fun changePassword(currentPassword: String, newPassword: String) = Unit
    override suspend fun changeEmail(currentPassword: String, newEmail: String) = Unit
    override suspend fun refreshIdToken() {
        refreshIdTokenCount++
    }
    /** Left null by default, so the interface's single-emission default is what runs. */
    override fun authStateChanges(): Flow<AuthState> = states ?: super.authStateChanges()
}

class AuthRepositoryTest {

    @Test
    fun initial_state_isLoading() {
        val repo = AuthRepository(StubBackend())
        assertEquals(AuthState.Loading, repo.state.value)
    }

    @Test
    fun refresh_signedOut_setsSignedOut() = runTest {
        val repo = AuthRepository(StubBackend(onCurrent = { AuthState.SignedOut }))
        repo.refresh()
        assertEquals(AuthState.SignedOut, repo.state.value)
    }

    /**
     * #494. A throw from the backend is the CALL failing, not an answer of "no
     * session": every backend reports a real absence as SignedOut. Reading it as
     * a sign-out is what put a sign-in screen in front of kinfolk who never
     * signed out, one for each of the short connection bursts the 2026-08-17
     * walk recorded.
     */
    @Test
    fun refresh_backendThrows_setsUnreachable_notSignedOut() = runTest {
        val repo = AuthRepository(StubBackend(onCurrent = {
            throw RuntimeException("Failed to fetch")
        }))
        repo.refresh()
        val s = repo.state.value
        assertTrue(s is AuthState.Unreachable, "a failed check must not read as a sign-out")
        assertEquals("Failed to fetch", (s as AuthState.Unreachable).reason)
    }
    /** A recovered connection resolves normally, with nothing left behind. */
    @Test
    fun refresh_afterUnreachable_resolvesOnceTheCallSucceeds() = runTest {
        var fail = true
        val repo = AuthRepository(StubBackend(onCurrent = {
            if (fail) throw RuntimeException("offline") else AuthState.SignedIn("u1", null, null)
        }))
        repo.refresh()
        assertTrue(repo.state.value is AuthState.Unreachable)
        fail = false
        repo.refresh()
        assertTrue(repo.state.value is AuthState.SignedIn)
    }
    @Test
    fun refresh_signedIn_setsSignedIn() = runTest {
        val repo = AuthRepository(StubBackend(onCurrent = {
            AuthState.SignedIn("u1", "a@b.co", "Name")
        }))
        repo.refresh()
        val s = repo.state.value
        assertTrue(s is AuthState.SignedIn)
        assertEquals("u1", (s as AuthState.SignedIn).uid)
        assertEquals("a@b.co", s.email)
    }

    @Test
    fun signInWithEmailPassword_setsSignedIn_withEmail() = runTest {
        val repo = AuthRepository(StubBackend())
        repo.signInWithEmailPassword("user@x.com", "pw")
        val s = repo.state.value
        assertTrue(s is AuthState.SignedIn)
        assertEquals("user@x.com", (s as AuthState.SignedIn).email)
    }

    @Test
    fun signInWithEmailPassword_propagatesBackendError() = runTest {
        val repo = AuthRepository(StubBackend(onPwSignIn = { _, _ -> error("invalid creds") }))
        assertFailsWith<IllegalStateException> {
            repo.signInWithEmailPassword("a", "b")
        }
        // State should NOT have flipped to SignedIn on failure.
        assertTrue(repo.state.value !is AuthState.SignedIn)
    }

    @Test
    fun sendMagicLink_doesNotChangeState() = runTest {
        val backend = StubBackend()
        val repo = AuthRepository(backend)
        repo.sendMagicLink("user@x.com")
        assertEquals(1, backend.magicSendCount)
        assertEquals(AuthState.Loading, repo.state.value)
    }

    @Test
    fun completeMagicLink_setsSignedIn() = runTest {
        val repo = AuthRepository(StubBackend())
        repo.completeMagicLink("a@b.co", "https://link")
        val s = repo.state.value
        assertTrue(s is AuthState.SignedIn)
        assertEquals("a@b.co", (s as AuthState.SignedIn).email)
    }

    @Test
    fun signInWithProvider_setsSignedIn() = runTest {
        val repo = AuthRepository(StubBackend())
        repo.signInWithProvider(AuthProviderId.GOOGLE, "id-token", null)
        val s = repo.state.value
        assertTrue(s is AuthState.SignedIn)
    }

    @Test
    fun test_sendPasswordReset_delegates_to_backend() = runTest {
        val backend = StubBackend()
        val repo = AuthRepository(backend)
        repo.sendPasswordReset("kinfolk@tribetails.com")
        assertEquals(1, backend.passwordResetCount)
        assertEquals("kinfolk@tribetails.com", backend.lastPasswordResetEmail)
        // State should remain unchanged (Loading).
        assertEquals(AuthState.Loading, repo.state.value)
    }

    @Test
    fun test_sendPasswordReset_propagatesBackendError() = runTest {
        val backend = StubBackend(onPasswordReset = { error("reset-failed") })
        val repo = AuthRepository(backend)
        assertFailsWith<IllegalStateException> {
            repo.sendPasswordReset("a@b.co")
        }
    }

    // ---- reCAPTCHA-missing retry layer (first-login 503 "Error code: 47") ----

    @Test
    fun signIn_retriesOnceTransparently_onRecaptchaMissingError() = runTest {
        var attempts = 0
        val repo = AuthRepository(StubBackend(onPwSignIn = { e, _ ->
            attempts++
            if (attempts == 1) error("Identity Toolkit 503: Error code: 47")
            AuthState.SignedIn("uid-$e", e, null)
        }))
        repo.signInWithEmailPassword("user@x.com", "pw")
        assertEquals(2, attempts)
        val s = repo.state.value
        assertTrue(s is AuthState.SignedIn, "retry must succeed without surfacing the error")
        assertEquals("user@x.com", (s as AuthState.SignedIn).email)
    }

    @Test
    fun signIn_doesNotRetry_onOtherErrors() = runTest {
        var attempts = 0
        val repo = AuthRepository(StubBackend(onPwSignIn = { _, _ ->
            attempts++
            error("invalid creds")
        }))
        assertFailsWith<IllegalStateException> {
            repo.signInWithEmailPassword("a", "b")
        }
        assertEquals(1, attempts, "non-reCAPTCHA failures must not be retried")
        assertTrue(repo.state.value !is AuthState.SignedIn)
    }

    @Test
    fun signIn_propagatesError_whenRetryAlsoFails() = runTest {
        var attempts = 0
        val repo = AuthRepository(StubBackend(onPwSignIn = { _, _ ->
            attempts++
            error("Error code: 47")
        }))
        assertFailsWith<IllegalStateException> {
            repo.signInWithEmailPassword("a", "b")
        }
        assertEquals(2, attempts, "exactly one transparent retry, then propagate")
    }

    @Test
    fun signInWithCustomToken_retriesOnce_onRecaptchaMissingError() = runTest {
        var attempts = 0
        val repo = AuthRepository(StubBackend(onPwSignIn = { e, _ ->
            attempts++
            if (attempts == 1) error("HTTP error 503") else AuthState.SignedIn("uid", e, null)
        }))
        repo.signInWithCustomToken("tok")
        assertEquals(2, attempts)
        assertTrue(repo.state.value is AuthState.SignedIn)
    }

    @Test
    fun signOut_setsSignedOut_andCallsBackend() = runTest {
        val backend = StubBackend(onCurrent = {
            AuthState.SignedIn("u", "a@b.co", null)
        })
        val repo = AuthRepository(backend)
        repo.refresh()
        assertTrue(repo.state.value is AuthState.SignedIn)
        repo.signOut()
        assertEquals(AuthState.SignedOut, repo.state.value)
        assertEquals(1, backend.signOutCount)
    }

    @Test
    fun refreshIdToken_delegatesToBackend() = runTest {
        val backend = StubBackend()
        val repo = AuthRepository(backend)
        repo.refreshIdToken()
        assertEquals(1, backend.refreshIdTokenCount)
    }
}

/**
 * NOTHING WAS LISTENING (#502).
 *
 * `refresh()` asks once. Before this, that was the only time the portal ever
 * heard from the sign-in service: `FirebaseAuthBackend.currentUser()` took
 * `authStateChanged.first()`, one emission, and then the app was deaf for the
 * rest of the session. A revoked session, an account signed out on another
 * device, a token that stopped being renewable, none of it reached a screen
 * until something else happened to call `refresh()`.
 *
 * These exercise the seam that makes it testable at all. `firebaseMain` has no
 * test source set, so the subscription had to be designed into `AuthBackend`
 * in `commonMain` first; what the real backend then does is map one flow to
 * another.
 */
class AuthRepositoryObserveTest {
    @Test
    fun observe_appliesEveryEmission_notJustTheFirst() = runTest {
        val states = MutableSharedFlow<AuthState>(replay = 0, extraBufferCapacity = 8)
        val repo = AuthRepository(StubBackend(states = states))
        val job = launch { repo.observe() }
        // runTest's scheduler is virtual: without this the collector has not
        // subscribed yet and a replay-less SharedFlow drops what nobody hears.
        runCurrent()
        states.emit(AuthState.SignedIn("u1", "kin@example.com", null))
        runCurrent()
        assertTrue(repo.state.value is AuthState.SignedIn, "first emission must land")
        // The whole point: the session ends mid-visit and the portal hears it.
        states.emit(AuthState.SignedOut)
        runCurrent()
        assertEquals(AuthState.SignedOut, repo.state.value)
        job.cancel()
    }
    @Test
    fun observe_neverFlashesLoadingBetweenEmissions() = runTest {
        // Loading is "no answer yet". Re-entering it on a later transition
        // would put a spinner over a screen somebody is already using.
        val states = MutableSharedFlow<AuthState>(extraBufferCapacity = 8)
        val repo = AuthRepository(StubBackend(states = states))
        val seen = mutableListOf<AuthState>()
        val watcher = launch { repo.state.collect { seen.add(it) } }
        val job = launch { repo.observe() }
        runCurrent()
        states.emit(AuthState.SignedIn("u1", null, null))
        runCurrent()
        states.emit(AuthState.SignedOut)
        runCurrent()
        assertEquals(1, seen.count { it == AuthState.Loading }, "Loading is the initial state only")
        job.cancel()
        watcher.cancel()
    }
    /** #494's rule, on this path too: a broken subscription is not a sign-out. */
    @Test
    fun observe_flowThrows_setsUnreachable_notSignedOut() = runTest {
        val repo = AuthRepository(StubBackend(states = flow { throw RuntimeException("socket closed") }))
        repo.observe()
        val s = repo.state.value
        assertTrue(s is AuthState.Unreachable, "a dead subscription must not read as a sign-out")
        assertEquals("socket closed", (s as AuthState.Unreachable).reason)
    }
    @Test
    fun observe_throwMidStream_keepsTheStateItAlreadyKnew_asUnreachable() = runTest {
        val repo = AuthRepository(StubBackend(states = flow {
            emit(AuthState.SignedIn("u1", null, null))
            throw RuntimeException("stream died")
        }))
        repo.observe()
        assertTrue(repo.state.value is AuthState.Unreachable)
    }
    /**
     * The default implementation is what the REST backend and every fake use,
     * and it has to reproduce exactly what the portal did before: resolve once,
     * from currentUser().
     */
    @Test
    fun observe_defaultBackend_emitsCurrentUserOnce_thenCompletes() = runTest {
        val repo = AuthRepository(StubBackend(onCurrent = { AuthState.SignedIn("u1", "a@b.co", null) }))
        repo.observe()
        val s = repo.state.value
        assertTrue(s is AuthState.SignedIn)
        assertEquals("u1", (s as AuthState.SignedIn).uid)
    }
    @Test
    fun observe_defaultBackend_currentUserThrows_isUnreachable() = runTest {
        val repo = AuthRepository(StubBackend(onCurrent = { throw RuntimeException("Failed to fetch") }))
        repo.observe()
        assertTrue(repo.state.value is AuthState.Unreachable)
    }
    /** Cancelling the collector is how the composable releases it; nothing else moves. */
    @Test
    fun observe_stopsApplyingEmissionsOnceCancelled() = runTest {
        val states = MutableSharedFlow<AuthState>(extraBufferCapacity = 8)
        val repo = AuthRepository(StubBackend(states = states))
        val job = launch { repo.observe() }
        runCurrent()
        states.emit(AuthState.SignedIn("u1", null, null))
        runCurrent()
        job.cancel()
        job.join()
        states.emit(AuthState.SignedOut)
        runCurrent()
        assertTrue(repo.state.value is AuthState.SignedIn, "a cancelled collector applies nothing")
    }
}
