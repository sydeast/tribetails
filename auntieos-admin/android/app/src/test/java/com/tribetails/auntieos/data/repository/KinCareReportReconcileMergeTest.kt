package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.KinCareSession
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The client is not the author of `reconcileStatus`, and must not be able to
 * delete it.
 *
 * `reconcile_comms.py` runs `kin_care_reports` through the same pending-queue as
 * the comm logs. It selects work with `.where("reconcileStatus", "==", "pending")`
 * and stamps `reconcileStatus` / `reconciledAt` / `reconcileNotes` /
 * `reconcileClaimedAt` on the documents it handles. [KinCareReport] declares none
 * of those, nor the `_migratedFrom` / `_migratedAt` provenance the May visit_logs
 * migration wrote. A whole-document `set()` from an operator editing a draft
 * therefore deleted them, and the KinTale left the nightly pass for good - the
 * query could no longer see it - with nothing raised anywhere.
 *
 * Two things are pinned here, and they only mean something together:
 *
 *  1. the model does NOT carry the pipeline's fields (and should not start
 *     carrying them - see [updateKinCareReport]'s note on why owning that state
 *     client-side trades this bug for a quieter one), so
 *  2. the write MUST be a merge, because merge is the only thing that can
 *     preserve a field the client cannot name.
 *
 * The write mode is not asserted for its own sake. Each test replays the recorded
 * write against a stored document using Firestore's real semantics - `set(obj)`
 * REPLACES the document, `set(obj, merge())` overlays only the keys the payload
 * carries - and asserts on what survives. A test that merely counted
 * `SetOptions.merge()` calls would pass just as happily if merge stopped
 * preserving anything.
 *
 * No Robolectric: the Firestore write surface is mockk-stubbed and the returned
 * Tasks are already complete, so `await()` resolves inline on the JVM. Same shape
 * as ScopedFirestoreTest and AuthGateTest.
 */
class KinCareReportReconcileMergeTest {

    private val auth = mockk<FirebaseAuth>()
    private val firestore = mockk<FirebaseFirestore>()
    private val collection = mockk<CollectionReference>()
    private val docRef = mockk<DocumentReference>()

    /** The write the repo actually issued, and whether it asked Firestore to merge. */
    private data class RecordedWrite(val payload: Any, val merge: Boolean)

    private var recorded: RecordedWrite? = null

    private fun repo(collectionName: String, docId: String): KinCareRepository {
        every { auth.currentUser } returns mockk<FirebaseUser>(relaxed = true)
        every { firestore.collection(collectionName) } returns collection
        every { collection.document(docId) } returns docRef
        every { docRef.set(any()) } answers {
            recorded = RecordedWrite(firstArg(), merge = false)
            Tasks.forResult<Void>(null)
        }
        every { docRef.set(any(), any<SetOptions>()) } answers {
            recorded = RecordedWrite(firstArg(), merge = true)
            Tasks.forResult<Void>(null)
        }
        return KinCareRepository(
            authGate = AuthGate { auth },
            functionsProvider = { mockk() }, // lazy; never resolved on a write path
            firestoreProvider = { firestore },
            authProvider = { auth },
        )
    }

    /**
     * The keys a Firestore POJO write carries for [T]. A data class serialises
     * every declared property, blank ones included, so this is exactly the key
     * set the payload puts on the wire - and, by omission, exactly the set of
     * server-written fields a bare `set()` destroys.
     */
    private fun declaredKeys(type: Class<*>): Set<String> =
        type.declaredFields.map { it.name }.filterNot { it.startsWith("$") }.toSet()

    /**
     * Replays the recorded write against a stored document, as Firestore would.
     * `set(obj)` REPLACES the whole document; `set(obj, merge())` overlays only
     * the keys the payload carries and leaves every other stored key alone.
     */
    private fun serverDocAfterWrite(stored: Map<String, Any>, payloadType: Class<*>): Map<String, Any> {
        val write = requireNotNull(recorded) { "the repository issued no document write at all" }
        val incoming = declaredKeys(payloadType).associateWith { "written-by-client" as Any }
        return if (write.merge) stored + incoming else incoming
    }

    // ── the premise: the client cannot name these fields ──────────────────────

    @Test
    fun `KinCareReport declares none of the reconcile pipeline's fields`() {
        val keys = declaredKeys(KinCareReport::class.java)
        // Stamped by reconcile_comms.py; the client neither writes nor reads them.
        // If this ever fails, the fix went the wrong way: declaring them makes the
        // app an owner of pipeline state, so a save that races the pass writes the
        // stale value it read back over the claim.
        listOf("reconcileStatus", "reconciledAt", "reconcileNotes", "reconcileClaimedAt")
            .forEach { assertTrue("model must not own pipeline field $it", it !in keys) }
        // Migration provenance, stamped by migrate_visit_logs_to_kin_care_reports.py.
        assertTrue("_migratedFrom" !in keys)
        assertTrue("_migratedAt" !in keys)
        // Sanity: the reflection above is reading real fields, not an empty set.
        assertTrue("bodyCopy" in keys)
        assertTrue("sessionId" in keys)
    }

    // ── the defect ────────────────────────────────────────────────────────────

    @Test
    fun `saving a KinTale does not erase a server-set reconcileStatus`() {
        val stored = mapOf<String, Any>(
            "bodyCopy" to "the previous revision",
            "reconcileStatus" to "pending",
            "reconciledAt" to "2026-07-29T02:00:00Z",
            "reconcileNotes" to "",
            "reconcileClaimedAt" to "",
            "_migratedFrom" to "visit_logs/vl-88",
        )
        val report = KinCareReport(sessionId = "sess-1", bodyCopy = "operator's edit")

        val result = runBlocking {
            repo("kin_care_reports", report.id).updateKinCareReport(report)
        }

        assertTrue(result.isSuccess)
        val after = serverDocAfterWrite(stored, KinCareReport::class.java)
        // The whole point. Lose this and the report drops out of
        // `.where("reconcileStatus", "==", "pending")` and is never reconciled.
        assertEquals("pending", after["reconcileStatus"])
        assertEquals("2026-07-29T02:00:00Z", after["reconciledAt"])
        assertNotNull(after["reconcileNotes"])
        assertNotNull(after["reconcileClaimedAt"])
        assertEquals("visit_logs/vl-88", after["_migratedFrom"])
    }

    @Test
    fun `saving a KinTale still writes every modelled field, blanked ones included`() {
        // Merge must not become a way to sneak stale data through: a field the
        // operator deliberately cleared has to reach the server as cleared, not
        // fall back to whatever was stored.
        val stored = mapOf<String, Any>("title" to "an old headline", "reconcileStatus" to "pending")
        val report = KinCareReport(sessionId = "sess-1", title = "")

        runBlocking { repo("kin_care_reports", report.id).updateKinCareReport(report) }.getOrThrow()

        val after = serverDocAfterWrite(stored, KinCareReport::class.java)
        assertEquals("written-by-client", after["title"])
        assertEquals("pending", after["reconcileStatus"])
    }

    @Test
    fun `saving a KinTale stamps updatedAt rather than round-tripping the read value`() {
        val report = KinCareReport(sessionId = "sess-1", updatedAt = "1999-01-01T00:00:00Z")

        runBlocking { repo("kin_care_reports", report.id).updateKinCareReport(report) }.getOrThrow()

        val written = requireNotNull(recorded).payload as KinCareReport
        assertTrue(written.updatedAt != "1999-01-01T00:00:00Z")
        // ISO-8601 String, not a Firestore Timestamp: every reader of
        // KinCareReport.updatedAt parses it as a String.
        assertTrue(written.updatedAt.endsWith("Z"))
    }

    // ── the sibling site ──────────────────────────────────────────────────────

    @Test
    fun `saving a session does not erase the backfill provenance on a stub session`() {
        // cleanup_prod_data_pass2.py stamped `_backfilledFrom` / `_backfilledAt` /
        // `_reason` on the stub sessions it created for pre-cutover orphan
        // visit_logs. KinCareSession declares none of them.
        val keys = declaredKeys(KinCareSession::class.java)
        assertTrue("_backfilledFrom" !in keys)
        assertTrue("_reason" !in keys)

        val stored = mapOf<String, Any>(
            "_backfilledFrom" to "visit_logs/vl-12",
            "_backfilledAt" to "2026-05-17T00:00:00Z",
            "_reason" to "orphan_visit_log_pre_cutover",
        )
        val session = KinCareSession(kinfolkId = "fam-1")

        runBlocking { repo("kin_care_sessions", session.id).updateKinCareSession(session) }.getOrThrow()

        val after = serverDocAfterWrite(stored, KinCareSession::class.java)
        assertEquals("visit_logs/vl-12", after["_backfilledFrom"])
        assertEquals("orphan_visit_log_pre_cutover", after["_reason"])
    }

    // ── the site that was already safe ────────────────────────────────────────

    @Test
    fun `markReportSent patches named fields and never issues a document set`() {
        // This one was already correct: `update(map)` touches only the keys it
        // names, so it could not reach `reconcileStatus`. Pinned so a later
        // "simplify" back to set() has to fail a test to land.
        every { auth.currentUser } returns mockk<FirebaseUser>(relaxed = true)
        every { firestore.collection("kin_care_reports") } returns collection
        every { firestore.collection("kin_care_sessions") } returns collection
        every { collection.document(any()) } returns docRef
        val patched = mutableListOf<Map<String, Any>>()
        every { docRef.update(any<Map<String, Any>>()) } answers {
            patched += firstArg<Map<String, Any>>()
            Tasks.forResult<Void>(null)
        }
        every { docRef.set(any()) } answers {
            recorded = RecordedWrite(firstArg(), merge = false)
            Tasks.forResult<Void>(null)
        }
        val repo = KinCareRepository(
            authGate = AuthGate { auth },
            functionsProvider = { mockk() },
            firestoreProvider = { firestore },
            authProvider = { auth },
        )

        runBlocking { repo.markReportSent("rep-1", "sess-1", "sms", "SM123") }.getOrThrow()

        assertNull("markReportSent must not overwrite the document", recorded)
        assertTrue(patched.isNotEmpty())
        assertTrue(patched.none { "reconcileStatus" in it.keys })
        assertEquals("SENT", patched.first()["status"])
    }
}
