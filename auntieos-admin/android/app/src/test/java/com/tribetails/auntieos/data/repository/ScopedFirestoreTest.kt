package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.QuerySnapshot
import com.tribetails.auntieos.domain.TestMode
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.tasks.await
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Test

/**
 * Stage 0I seam tests: [ScopedFirestore] must apply the test-admin sandbox
 * constraint BEFORE any call-site code runs, and must leave the normal-admin
 * path untouched. Decision logic (claim -> TestMode, the scope selector) is
 * covered by TestModeTest; what is locked down here is the APPLICATION of that
 * decision to each Firestore access shape - query, single-doc read, count -
 * which used to be a hand-inlined `if (mode.active)` fork at every call site.
 *
 * No Robolectric: the Firestore surface (collection/whereEqualTo/document/get)
 * is mockk-stubbed and `get()` returns completed Tasks, so `await()` resolves
 * inline on the JVM. Each test builds its own mocks; nothing is shared.
 */
class ScopedFirestoreTest {

    private val firestore = mockk<FirebaseFirestore>()

    private val active = TestMode(active = true, testTribeId = "test-kinfolk-001")

    private fun seam(mode: TestMode) = ScopedFirestore(firestore) { mode }

    // ---- scopedQuery: kinfolkId-field-scoped collection query ----

    @Test
    fun `scopedQuery in sandbox mode constrains the query to the test kinfolk`() {
        val col = mockk<CollectionReference>()
        val scopedQ = mockk<Query>()
        val snap = mockk<QuerySnapshot>()
        every { firestore.collection("kin") } returns col
        every { col.whereEqualTo("kinfolkId", "test-kinfolk-001") } returns scopedQ
        every { scopedQ.get() } returns Tasks.forResult(snap)

        val result = runBlocking { seam(active).scopedQuery("kin") }

        assertSame(snap, result)
        // The broad (permission-denied) collection read must never happen.
        verify(exactly = 0) { col.get() }
    }

    @Test
    fun `scopedQuery for normal admin passes the collection through unscoped`() {
        val col = mockk<CollectionReference>()
        val snap = mockk<QuerySnapshot>()
        every { firestore.collection("invoices") } returns col
        every { col.get() } returns Tasks.forResult(snap)

        val result = runBlocking { seam(TestMode.OFF).scopedQuery("invoices") }

        assertSame(snap, result)
        verify(exactly = 0) { col.whereEqualTo(any<String>(), any()) }
    }

    @Test
    fun `scopedQuery applies common clauses AFTER the sandbox constraint`() {
        val col = mockk<CollectionReference>()
        val scopedQ = mockk<Query>()
        val built = mockk<Query>()
        val snap = mockk<QuerySnapshot>()
        every { firestore.collection("kin_care_sessions") } returns col
        every { col.whereEqualTo("kinfolkId", "test-kinfolk-001") } returns scopedQ
        every { scopedQ.orderBy("startTime") } returns built
        every { built.get() } returns Tasks.forResult(snap)

        val result = runBlocking {
            seam(active).scopedQuery("kin_care_sessions") { orderBy("startTime") }
        }

        assertSame(snap, result)
        // The clauses were chained onto the SCOPED query, never the bare collection.
        verify(exactly = 0) { col.orderBy(any<String>()) }
    }

    @Test
    fun `scopedQuery applies common clauses to the bare collection for normal admin`() {
        val col = mockk<CollectionReference>()
        val built = mockk<Query>()
        val snap = mockk<QuerySnapshot>()
        every { firestore.collection("kin_care_sessions") } returns col
        every { col.orderBy("startTime") } returns built
        every { built.get() } returns Tasks.forResult(snap)

        val result = runBlocking {
            seam(TestMode.OFF).scopedQuery("kin_care_sessions") { orderBy("startTime") }
        }

        assertSame(snap, result)
        verify(exactly = 0) { col.whereEqualTo(any<String>(), any()) }
    }

    @Test
    fun `scopedQuery scopes by a custom field name (snake_case kinfolk_id)`() {
        val col = mockk<CollectionReference>()
        val scopedQ = mockk<Query>()
        val snap = mockk<QuerySnapshot>()
        every { firestore.collection("generated_drafts") } returns col
        every { col.whereEqualTo("kinfolk_id", "test-kinfolk-001") } returns scopedQ
        every { scopedQ.get() } returns Tasks.forResult(snap)

        val result = runBlocking { seam(active).scopedQuery("generated_drafts", field = "kinfolk_id") }

        assertSame(snap, result)
        verify(exactly = 0) { col.whereEqualTo("kinfolkId", any()) }
    }

    // ---- scopedQuery (divergent shape): sandbox and unscoped paths differ ----

    @Test
    fun `divergent scopedQuery in sandbox mode hands the ALREADY-scoped query to the sandbox path`() {
        val col = mockk<CollectionReference>()
        val scopedQ = mockk<Query>()
        every { firestore.collection("generated_drafts") } returns col
        every { col.whereEqualTo("kinfolk_id", "test-kinfolk-001") } returns scopedQ

        var received: Query? = null
        var receivedTribe: String? = null
        val result = runBlocking {
            seam(active).scopedQuery(
                "generated_drafts",
                field = "kinfolk_id",
                sandbox = { q ->
                    received = q
                    receivedTribe = testTribeId
                    "sandbox"
                },
                unscoped = { "unscoped" },
            )
        }

        assertEquals("sandbox", result)
        // The scoping was applied BEFORE the call-site lambda ran - it cannot be forgotten.
        assertSame(scopedQ, received)
        // The active TestMode is the lambda receiver (e.g. for allowsKinfolkDoc-style gates).
        assertEquals("test-kinfolk-001", receivedTribe)
    }

    @Test
    fun `divergent scopedQuery for normal admin runs only the unscoped path on the bare collection`() {
        val col = mockk<CollectionReference>()
        every { firestore.collection("generated_drafts") } returns col

        var received: Query? = null
        val result = runBlocking {
            seam(TestMode.OFF).scopedQuery(
                "generated_drafts",
                field = "kinfolk_id",
                sandbox = { error("sandbox path must not run for a normal admin") },
                unscoped = { c ->
                    received = c
                    "unscoped"
                },
            )
        }

        assertEquals("unscoped", result)
        assertSame(col, received)
        verify(exactly = 0) { col.whereEqualTo(any<String>(), any()) }
    }

    // ---- scopedRead: doc-id-scoped collection (kinfolk) collapses to one doc ----

    @Test
    fun `scopedRead in sandbox mode collapses to the single reachable doc`() {
        val col = mockk<CollectionReference>()
        val docRef = mockk<DocumentReference>()
        val docSnap = mockk<DocumentSnapshot>()
        every { firestore.collection("kinfolk") } returns col
        every { col.document("test-kinfolk-001") } returns docRef
        every { docRef.get() } returns Tasks.forResult(docSnap)

        var received: DocumentSnapshot? = null
        val result = runBlocking {
            seam(active).scopedRead(
                "kinfolk",
                sandbox = { doc ->
                    received = doc
                    "sandbox:$testTribeId"
                },
                unscoped = { "unscoped" },
            )
        }

        assertEquals("sandbox:test-kinfolk-001", result)
        assertSame(docSnap, received)
        // The broad collection read must never happen for a test admin.
        verify(exactly = 0) { col.get() }
    }

    @Test
    fun `scopedRead for normal admin hands the bare collection to the unscoped path`() {
        val col = mockk<CollectionReference>()
        every { firestore.collection("kinfolk") } returns col

        var received: CollectionReference? = null
        val result = runBlocking {
            seam(TestMode.OFF).scopedRead(
                "kinfolk",
                sandbox = { error("sandbox path must not run for a normal admin") },
                unscoped = { c ->
                    received = c
                    "unscoped"
                },
            )
        }

        assertEquals("unscoped", result)
        assertSame(col, received)
        verify(exactly = 0) { col.document(any()) }
    }

    @Test
    fun `scopedRead count shape - doc existence collapses to 0 or 1`() {
        val col = mockk<CollectionReference>()
        val docRef = mockk<DocumentReference>()
        val docSnap = mockk<DocumentSnapshot>()
        every { firestore.collection("kinfolk") } returns col
        every { col.document("test-kinfolk-001") } returns docRef
        every { docRef.get() } returns Tasks.forResult(docSnap)
        every { docSnap.exists() } returns true

        val count = runBlocking {
            seam(active).scopedRead(
                "kinfolk",
                sandbox = { doc -> if (doc.exists()) 1 else 0 },
                unscoped = { c -> c.get().await().size() },
            )
        }

        assertEquals(1, count)
        verify(exactly = 0) { col.get() }
    }

    // ---- scopedCount: kinfolkId-field-scoped count ----

    @Test
    fun `scopedCount in sandbox mode sizes the scoped snapshot`() {
        val col = mockk<CollectionReference>()
        val scopedQ = mockk<Query>()
        val snap = mockk<QuerySnapshot>()
        every { firestore.collection("kin") } returns col
        every { col.whereEqualTo("kinfolkId", "test-kinfolk-001") } returns scopedQ
        every { scopedQ.get() } returns Tasks.forResult(snap)
        every { snap.size() } returns 4

        val count = runBlocking { seam(active).scopedCount("kin") }

        assertEquals(4, count)
        verify(exactly = 0) { col.get() }
    }

    @Test
    fun `scopedCount for normal admin sizes the collection with unscoped clauses applied`() {
        val col = mockk<CollectionReference>()
        val filtered = mockk<Query>()
        val snap = mockk<QuerySnapshot>()
        every { firestore.collection("generated_drafts") } returns col
        every { col.whereEqualTo("status", "pending") } returns filtered
        every { filtered.get() } returns Tasks.forResult(snap)
        every { snap.size() } returns 7

        val count = runBlocking {
            seam(TestMode.OFF).scopedCount(
                "generated_drafts",
                field = "kinfolk_id",
                unscoped = { whereEqualTo("status", "pending") },
            )
        }

        assertEquals(7, count)
        // No sandbox scope clause for the operator.
        verify(exactly = 0) { col.whereEqualTo("kinfolk_id", any()) }
    }

    @Test
    fun `scopedCount custom sandbox counter receives the scoped snapshot`() {
        val col = mockk<CollectionReference>()
        val scopedQ = mockk<Query>()
        val snap = mockk<QuerySnapshot>()
        every { firestore.collection("generated_drafts") } returns col
        every { col.whereEqualTo("kinfolk_id", "test-kinfolk-001") } returns scopedQ
        every { scopedQ.get() } returns Tasks.forResult(snap)

        var received: QuerySnapshot? = null
        val count = runBlocking {
            seam(active).scopedCount(
                "generated_drafts",
                field = "kinfolk_id",
                sandbox = { s ->
                    received = s
                    2
                },
                unscoped = { whereEqualTo("status", "pending") },
            )
        }

        assertEquals(2, count)
        assertSame(snap, received)
        // The sandbox path must not use the operator's status-filtered server query.
        verify(exactly = 0) { col.whereEqualTo("status", any()) }
    }

    // ---- mode-source contract ----

    @Test
    fun `a failing mode source propagates BEFORE any Firestore access (fail-loud)`() {
        val seam = ScopedFirestore(firestore) {
            throw IllegalStateException("Could not resolve test-mode claim before a scoped read")
        }

        assertThrows(IllegalStateException::class.java) {
            runBlocking { seam.scopedQuery("kin") }
        }
        assertThrows(IllegalStateException::class.java) {
            runBlocking { seam.scopedRead("kinfolk", sandbox = { }, unscoped = { }) }
        }
        assertThrows(IllegalStateException::class.java) {
            runBlocking { seam.scopedCount("kin") }
        }
        // No query may leak out unscoped when the claim cannot be read.
        verify(exactly = 0) { firestore.collection(any()) }
    }

    @Test
    fun `the mode source is re-resolved on every call, not snapshotted at construction`() {
        val col = mockk<CollectionReference>()
        val scopedQ = mockk<Query>()
        val snap = mockk<QuerySnapshot>()
        every { firestore.collection("kin") } returns col
        every { col.get() } returns Tasks.forResult(snap)
        every { col.whereEqualTo("kinfolkId", "test-kinfolk-001") } returns scopedQ
        every { scopedQ.get() } returns Tasks.forResult(snap)

        var current = TestMode.OFF
        val seam = ScopedFirestore(firestore) { current }

        runBlocking { seam.scopedQuery("kin") }
        verify(exactly = 0) { col.whereEqualTo(any<String>(), any()) }

        // Claim flips (e.g. re-read after sign-in as a test admin): the same seam
        // instance must now scope.
        current = active
        runBlocking { seam.scopedQuery("kin") }
        verify(exactly = 1) { col.whereEqualTo("kinfolkId", "test-kinfolk-001") }
    }
}
