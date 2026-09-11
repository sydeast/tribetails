package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.auth.AuthResult
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.GetTokenResult
import com.tribetails.auntieos.data.api.N8nApi
import io.mockk.every
import io.mockk.just
import io.mockk.mockk
import io.mockk.Runs
import io.mockk.verify
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What must be true when an admin sign-in is REFUSED.
 *
 * `signInAdmin` really does sign the account in before it can read the `admin`
 * claim, so a refusal is a session that started and then had to be torn down.
 * Tearing it down means two things, not one: Firebase signs the user out, and
 * the [AuthGate] claim cache drops the `testTribeId` it may be holding. This app
 * exists to keep one business's records apart from another's, so a sandbox scope
 * that outlives a refused sign-in is the kind of leak that shows up as one
 * tribe's data answering another tribe's query.
 *
 * The refusal path used to call `auth.signOut()` on its own and skip the cache,
 * which is the asymmetry these tests pin shut. Both paths now go through the one
 * private teardown, so the test for [AuntieRepository.signOut] below is really a
 * test that the second caller cannot drift away from the first.
 *
 * No Robolectric: one mockk `FirebaseAuth` is wired into BOTH the repository and
 * the gate, which is the production topology (one auth, one claim cache), and
 * `getIdToken` returns completed Tasks so `await()` resolves inline on the JVM,
 * exactly as [AuthGateTest] does.
 */
class AuntieRepositorySignInAdminTest {

    private val auth = mockk<FirebaseAuth>()
    private val gate = AuthGate { auth }
    private val repo = AuntieRepository(
        n8n = mockk<N8nApi>(),
        authGate = gate,
        authProvider = { auth },
    )

    /** The account Firebase hands back for the next call, carrying [claims]. */
    private fun signedInAs(uid: String, claims: Map<String, Any>) {
        val user = mockk<FirebaseUser>()
        val token = mockk<GetTokenResult>()
        every { token.claims } returns claims
        every { user.uid } returns uid
        every { user.getIdToken(true) } returns Tasks.forResult(token)
        every { auth.currentUser } returns user
    }

    private fun signInSucceeds() {
        every { auth.signInWithEmailAndPassword(any(), any()) } returns
            Tasks.forResult(mockk<AuthResult>(relaxed = true))
        every { auth.signOut() } just Runs
    }

    @Test
    fun `a refused sign-in leaves no tribe scope behind for the next account`() {
        signInSucceeds()

        // A sandboxed admin is signed in and something reads the claim, so the
        // shared gate is now holding tribe-a.
        signedInAs("admin-a", mapOf("admin" to true, "testTribeId" to "tribe-a"))
        assertEquals("tribe-a", runBlocking { gate.requireTestMode() }.testTribeId)

        // Someone without the admin claim tries to sign in on the same device.
        signedInAs("not-an-admin", mapOf("testTribeId" to "tribe-a"))
        val refused = runBlocking { repo.signInAdmin("nobody@example.com", "hunter2") }

        assertTrue(refused.isFailure)
        assertEquals("This account does not have admin access.", refused.exceptionOrNull()?.message)
        verify { auth.signOut() }

        // A plain admin, in no sandbox at all, signs in next. If the refusal
        // above had left tribe-a cached, this admin would be scoped to another
        // business's records without anything on screen saying so.
        signedInAs("admin-c", mapOf("admin" to true))
        assertFalse(runBlocking { gate.requireTestMode() }.active)
    }

    @Test
    fun `an ordinary sign-out clears the same cache the refusal does`() {
        signInSucceeds()

        signedInAs("admin-a", mapOf("admin" to true, "testTribeId" to "tribe-a"))
        assertEquals("tribe-a", runBlocking { gate.requireTestMode() }.testTribeId)

        assertTrue(runBlocking { repo.signOut() }.isSuccess)
        verify { auth.signOut() }

        signedInAs("admin-c", mapOf("admin" to true))
        assertFalse(runBlocking { gate.requireTestMode() }.active)
    }

    @Test
    fun `an accepted sign-in keeps the session, and tears nothing down`() {
        signInSucceeds()
        signedInAs("admin-a", mapOf("admin" to true, "testTribeId" to "tribe-a"))

        val accepted = runBlocking { repo.signInAdmin("admin@example.com", "hunter2") }

        assertTrue(accepted.isSuccess)
        verify(exactly = 0) { auth.signOut() }
        // The signed-in admin's own sandbox is still readable afterwards.
        assertEquals("tribe-a", runBlocking { gate.requireTestMode() }.testTribeId)
    }
}
