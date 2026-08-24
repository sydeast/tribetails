package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import com.google.firebase.firestore.WriteBatch
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
 *     carrying them - see [updateKinCareReportFields]'s note on why owning that state
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

    /**
     * The same replay for a FIELD-MAP payload, which is what a KinTale save now
     * sends. The payload is the map itself, so what lands is exactly its keys - and
     * that is the property the whole change turns on.
     */
    @Suppress("UNCHECKED_CAST")
    private fun serverDocAfterFieldWrite(stored: Map<String, Any>): Map<String, Any?> {
        val write = requireNotNull(recorded) { "the repository issued no document write at all" }
        val incoming = write.payload as Map<String, Any?>
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

        val result = runBlocking {
            repo("kin_care_reports", "rep-1")
                .updateKinCareReportFields("rep-1", mapOf("bodyCopy" to "operator's edit"))
        }

        assertTrue(result.isSuccess)
        val after = serverDocAfterFieldWrite(stored)
        // The whole point. Lose this and the report drops out of
        // `.where("reconcileStatus", "==", "pending")` and is never reconciled.
        assertEquals("pending", after["reconcileStatus"])
        assertEquals("2026-07-29T02:00:00Z", after["reconciledAt"])
        assertNotNull(after["reconcileNotes"])
        assertNotNull(after["reconcileClaimedAt"])
        assertEquals("visit_logs/vl-88", after["_migratedFrom"])
        assertEquals("operator's edit", after["bodyCopy"])
    }

    /**
     * THE FIELD MAP IS THE FIRST LINE OF DEFENCE AND MERGE IS STILL THE SECOND.
     *
     * The payload now names only the keys that changed, so the pipeline's fields sit
     * OUTSIDE the written map rather than merely being preserved by it. Merge still
     * matters: the same field map handed to a bare `set()` would delete every key it
     * does not name, which on this document is most of them.
     */
    @Test
    fun `a KinTale field write is a merge, not a document replacement`() {
        runBlocking {
            repo("kin_care_reports", "rep-1")
                .updateKinCareReportFields("rep-1", mapOf("title" to "a new headline"))
        }.getOrThrow()

        assertTrue("a field-level write must merge", requireNotNull(recorded).merge)
    }

    /**
     * THE FIELDS THIS EDITOR DOES NOT OWN NEVER REACH THE WIRE, which is the whole
     * of the change on this collection. Before it, every save carried all 30
     * modelled fields at the values the client last read, reverting a triage
     * decision or a send made while the draft sat open.
     */
    @Test
    fun `a KinTale field write carries only the named fields plus the stamp`() {
        val stored = mapOf<String, Any>(
            "triageStatus" to "assigned",
            "triagedBy" to "admin-1",
            "status" to "SENT",
        )

        runBlocking {
            repo("kin_care_reports", "rep-1")
                .updateKinCareReportFields("rep-1", mapOf("bodyCopy" to "operator's edit"))
        }.getOrThrow()

        @Suppress("UNCHECKED_CAST")
        val payload = requireNotNull(recorded).payload as Map<String, Any?>
        assertEquals(setOf("bodyCopy", "updatedAt"), payload.keys)

        val after = serverDocAfterFieldWrite(stored)
        assertEquals("assigned", after["triageStatus"])
        assertEquals("admin-1", after["triagedBy"])
        assertEquals("SENT", after["status"])
    }

    /**
     * A field the operator deliberately CLEARED still reaches the server as cleared.
     * Whether a blank is a change is decided against the loaded baseline in the
     * ViewModel; whatever the differ names is written verbatim here.
     */
    @Test
    fun `a cleared field is written as the blank the operator left`() {
        val stored = mapOf<String, Any>("title" to "an old headline", "reconcileStatus" to "pending")

        runBlocking {
            repo("kin_care_reports", "rep-1").updateKinCareReportFields("rep-1", mapOf("title" to ""))
        }.getOrThrow()

        val after = serverDocAfterFieldWrite(stored)
        assertEquals("", after["title"])
        assertEquals("pending", after["reconcileStatus"])
    }

    /**
     * AN EMPTY WRITE IS REFUSED RATHER THAN STAMPED. `updatedAt` says when the
     * KinTale last changed, and moving it for a save that changed nothing makes it
     * lie - which matters more once the editor autosaves, because the operator
     * reads that stamp as "my work is safe as of then".
     */
    @Test
    fun `a write with no changed fields is refused and touches nothing`() {
        val result = runBlocking {
            repo("kin_care_reports", "rep-1").updateKinCareReportFields("rep-1", emptyMap())
        }

        assertTrue(result.isFailure)
        assertNull("no document write may be issued at all", recorded)
    }

    @Test
    fun `saving a KinTale stamps updatedAt rather than round-tripping the read value`() {
        runBlocking {
            repo("kin_care_reports", "rep-1")
                .updateKinCareReportFields("rep-1", mapOf("updatedAt" to "1999-01-01T00:00:00Z"))
        }.getOrThrow()

        @Suppress("UNCHECKED_CAST")
        val payload = requireNotNull(recorded).payload as Map<String, Any?>
        val written = payload["updatedAt"] as String
        assertTrue(written != "1999-01-01T00:00:00Z")
        // ISO-8601 String, not a Firestore Timestamp: every reader of
        // KinCareReport.updatedAt parses it as a String.
        assertTrue(written.endsWith("Z"))
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
        // The write MODE here was always correct: `update(map)` touches only the
        // keys it names, so it could not reach `reconcileStatus`. Pinned so a
        // later "simplify" back to set() has to fail a test to land. Batching the
        // two writes (#552) does not change that - `WriteBatch.update` carries the
        // same named-field semantics - and the atomicity itself is pinned by the
        // test below.
        val batch = stubBatch()
        val repo = KinCareRepository(
            authGate = AuthGate { auth },
            functionsProvider = { mockk() },
            firestoreProvider = { firestore },
            authProvider = { auth },
        )

        runBlocking { repo.markReportSent("rep-1", "sess-1", "sms", "SM123") }.getOrThrow()

        assertNull("markReportSent must not overwrite the document", recorded)
        assertTrue(batch.patched.isNotEmpty())
        assertTrue(batch.patched.none { "reconcileStatus" in it.keys })
        assertEquals("SENT", batch.patched.first()["status"])
    }

    /**
     * #552: the send transition is ONE commit, not two round trips.
     *
     * The report flipping to SENT and the session counting the send are halves of
     * one fact. Split across two `await()`ed updates, a failure between them left
     * a KinTale announced as sent whose session never counted it - and
     * `sentReportCount` is what `autoCompleteEligible` is derived from, so the
     * visit quietly stopped being auto-completable with nothing raised anywhere.
     * The web client (`api/kinTalesWrite.ts#sendKinTale`) has always used one
     * `writeBatch` over the same two documents; this is that guarantee on Android.
     */
    @Test
    fun `markReportSent commits the report flip and the session bump as one batch`() {
        val batch = stubBatch()
        val repo = KinCareRepository(
            authGate = AuthGate { auth },
            functionsProvider = { mockk() },
            firestoreProvider = { firestore },
            authProvider = { auth },
        )

        runBlocking { repo.markReportSent("rep-1", "sess-1", "sms", "SM123") }.getOrThrow()

        // Both documents, inside the batch, then exactly one commit.
        assertEquals(2, batch.patched.size)
        assertEquals(1, batch.commits)
        assertEquals("SENT", batch.patched[0]["status"])
        assertTrue("the session side must ride the same commit", batch.patched[1].containsKey("sentReportCount"))
        assertEquals(true, batch.patched[1]["autoCompleteEligible"])
        // Nothing was written outside the batch on the way there.
        assertEquals(0, looseUpdates.size)
    }

    /** Named-field updates issued straight on a DocumentReference, outside any batch. */
    private val looseUpdates = mutableListOf<Map<String, Any>>()

    private class StubBatch {
        val patched = mutableListOf<Map<String, Any>>()
        var commits = 0
    }

    /**
     * Wire `firestore.batch()` to a recorder. Returns it so a test can read what
     * the batch was handed and how many times it was committed.
     */
    private fun stubBatch(): StubBatch {
        val recorder = StubBatch()
        val batch = mockk<WriteBatch>()
        every { auth.currentUser } returns mockk<FirebaseUser>(relaxed = true)
        every { firestore.collection("kin_care_reports") } returns collection
        every { firestore.collection("kin_care_sessions") } returns collection
        every { collection.document(any()) } returns docRef
        every { firestore.batch() } returns batch
        every { batch.update(any<DocumentReference>(), any<Map<String, Any>>()) } answers {
            recorder.patched += secondArg<Map<String, Any>>()
            batch
        }
        every { batch.commit() } answers {
            recorder.commits++
            Tasks.forResult<Void>(null)
        }
        every { docRef.update(any<Map<String, Any>>()) } answers {
            looseUpdates += firstArg<Map<String, Any>>()
            Tasks.forResult<Void>(null)
        }
        every { docRef.set(any()) } answers {
            recorded = RecordedWrite(firstArg(), merge = false)
            Tasks.forResult<Void>(null)
        }
        return recorder
    }
}
