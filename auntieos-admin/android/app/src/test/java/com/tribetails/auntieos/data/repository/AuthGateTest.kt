package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.auth.GetTokenResult
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.QuerySnapshot
import com.tribetails.auntieos.data.api.N8nApi
import com.tribetails.auntieos.data.model.Invoice
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * W4-2 seam tests: [AuthGate] must give every domain repo the same answer to
 * "is an admin signed in" and "which sandbox are they in", and must read the
 * `testTribeId` claim ONCE.
 *
 * What is pinned here is what the W4-1 duplicate existed to protect. The
 * signed-out message is user-facing, so it is asserted as a whole string rather
 * than by type. The cache is asserted by COUNTING token reads, because "cached
 * in one place" is only true if a second call does not go back to Firebase.
 *
 * No Robolectric: FirebaseAuth / FirebaseUser / GetTokenResult are mockk-stubbed
 * and `getIdToken` returns completed Tasks, so `await()` resolves inline on the
 * JVM, exactly as ScopedFirestoreTest does with the Firestore surface.
 */
class AuthGateTest {

    private val auth = mockk<FirebaseAuth>()
    private val user = mockk<FirebaseUser>()

    private fun gate() = AuthGate { auth }

    /** Signed in, ID token carrying [claims]. */
    private fun signedIn(claims: Map<String, Any> = emptyMap()) {
        val token = mockk<GetTokenResult>()
        every { token.claims } returns claims
        every { auth.currentUser } returns user
        every { user.uid } returns "admin-uid"
        every { user.getIdToken(true) } returns Tasks.forResult(token)
    }

    private fun signedOut() {
        every { auth.currentUser } returns null
    }

    // ── the sign-in gate ─────────────────────────────────────────────────────

    @Test
    fun `a signed-out call fails with the operator's sentence, word for word`() {
        signedOut()
        val thrown = assertThrows(IllegalStateException::class.java) { gate().ensureAuthenticated() }
        // This string reaches the screen. It was copied into InvoiceRepository by
        // W4-1 precisely so a carved repo would not start failing with a raw
        // Firebase permission error instead; now it has one definition.
        assertEquals("Admin sign-in required before using AuntieOS.", thrown.message)
    }

    @Test
    fun `a signed-in call passes the gate`() {
        signedIn()
        gate().ensureAuthenticated()
    }

    @Test
    fun `the claim read is gated too - signed out means no token fetch`() {
        signedOut()
        val result = runBlocking { gate().testMode() }
        assertTrue(result.isFailure)
        assertEquals("Admin sign-in required before using AuntieOS.", result.exceptionOrNull()?.message)
        verify(exactly = 0) { user.getIdToken(any()) }
    }

    // ── the claim read, and its single cache ─────────────────────────────────

    @Test
    fun `a testTribeId claim yields the sandbox mode`() {
        signedIn(mapOf("testTribeId" to "test-kinfolk-001"))
        val mode = runBlocking { gate().requireTestMode() }
        assertTrue(mode.active)
        assertEquals("test-kinfolk-001", mode.testTribeId)
    }

    @Test
    fun `no testTribeId claim yields the normal-admin mode`() {
        signedIn(mapOf("admin" to true))
        assertFalse(runBlocking { gate().requireTestMode() }.active)
    }

    @Test
    fun `the claim is read ONCE and served from cache after that`() {
        signedIn(mapOf("testTribeId" to "test-kinfolk-001"))
        val gate = gate()

        val first = runBlocking { gate.requireTestMode() }
        val second = runBlocking { gate.requireTestMode() }
        val third = runBlocking { gate.testMode().getOrThrow() }

        assertEquals(first, second)
        assertEquals(first, third)
        // Three resolutions, one token fetch. Per-query scoping runs this on
        // every kinfolk-scoped read in the app, which is why it is cached.
        verify(exactly = 1) { user.getIdToken(true) }
    }

    @Test
    fun `forceRefresh re-reads the token so a server-set claim lands without a restart`() {
        signedIn(mapOf("admin" to true))
        val gate = gate()
        runBlocking { gate.requireTestMode() }

        // The operator is granted testTribeId server-side mid-session.
        signedIn(mapOf("testTribeId" to "test-kinfolk-001"))
        val refreshed = runBlocking { gate.testMode(forceRefresh = true).getOrThrow() }

        assertTrue(refreshed.active)
        assertEquals("test-kinfolk-001", refreshed.testTribeId)
        verify(exactly = 2) { user.getIdToken(true) }
    }

    @Test
    fun `clearing the cache on sign-out makes the next account read its own claim`() {
        signedIn(mapOf("testTribeId" to "test-kinfolk-001"))
        val gate = gate()
        assertTrue(runBlocking { gate.requireTestMode() }.active)

        // What signOut() does, then a normal admin signs in on the same device.
        gate.clearTestModeCache()
        signedIn(mapOf("admin" to true))

        assertFalse(runBlocking { gate.requireTestMode() }.active)
        verify(exactly = 2) { user.getIdToken(true) }
    }

    @Test
    fun `an unreadable claim fails loud and caches nothing`() {
        every { auth.currentUser } returns user
        every { user.uid } returns "admin-uid"
        every { user.getIdToken(true) } returns Tasks.forException(RuntimeException("token fetch failed"))
        val gate = gate()

        val thrown = assertThrows(IllegalStateException::class.java) {
            runBlocking { gate.requireTestMode() }
        }
        assertEquals("Could not resolve test-mode claim before a scoped read", thrown.message)

        // Nothing was cached, so a later call still tries: a failed claim read
        // must never harden into "this account is a normal admin".
        assertTrue(runBlocking { gate.testMode() }.isFailure)
        verify(exactly = 2) { user.getIdToken(true) }
    }

    // ── construction ─────────────────────────────────────────────────────────

    @Test
    fun `constructing the gate touches no Firebase singleton`() {
        // The FirebaseAuth handle is a lazy PROVIDER, which is what makes
        // AuthGate.shared safe as a constructor default in a Firebase-less test.
        // Turning it into an eager argument would blow up every repo's
        // construction test instead of here.
        var resolved = 0
        val gate = AuthGate { resolved++; auth }
        assertNotNull(gate)
        assertEquals(0, resolved)

        signedOut()
        assertThrows(IllegalStateException::class.java) { gate.ensureAuthenticated() }
        assertEquals(1, resolved)
    }

    // ── one gate, one cache, across repos ────────────────────────────────────

    @Test
    fun `every repo defaults to the SAME gate, so there is one claim cache`() {
        // The invariant W4-2 exists for. A per-repo gate would compile, pass its
        // own tests, and quietly cost one token read per repo per session, with
        // a stale testTribeId able to outlive a sign-out in whichever repo the
        // sign-out did not touch.
        assertSame(AuthGate.shared, AuntieRepository(mockk<N8nApi>()).authGate)
        assertSame(AuthGate.shared, InvoiceRepository().authGate)
    }

    // ── plumbing: gate to repo to ScopedFirestore ────────────────────────────

    @Test
    fun `the gate's claim reaches a domain repo's scoped reads`() {
        // End to end over the boundary: AuthGate SOURCES the mode, ScopedFirestore
        // APPLIES it. A sandbox claim read here must come out as the sandbox
        // constraint on the invoices query the repo runs.
        signedIn(mapOf("testTribeId" to "test-kinfolk-001"))
        val firestore = mockk<FirebaseFirestore>()
        val col = mockk<CollectionReference>()
        val scopedQ = mockk<Query>()
        val snap = mockk<QuerySnapshot>()
        every { firestore.collection("invoices") } returns col
        every { col.whereEqualTo("kinfolkId", "test-kinfolk-001") } returns scopedQ
        every { scopedQ.get() } returns Tasks.forResult(snap)
        every { snap.toObjects(Invoice::class.java) } returns emptyList()

        val repo = InvoiceRepository(authGate = gate(), firestoreProvider = { firestore })
        val result = runBlocking { repo.getInvoices() }

        assertTrue(result.isSuccess)
        // The broad read a test admin would be permission-denied for never ran.
        verify(exactly = 0) { col.get() }
    }
}
