package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import com.google.firebase.firestore.Transaction
import com.tribetails.auntieos.data.api.N8nApi
import com.tribetails.auntieos.data.model.CallLog
import io.mockk.every
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `calls_log/{CallSid}` has two writers racing on one document, and the phone
 * used to lose both races.
 *
 * Twilio's webhook `mytribe/functions/src/twilio/twilioInbound.ts`
 * (`twilioInboundCallHandler`) merge-upserts the call's `recordingUrl`,
 * `durationSec`, `status` and the `kinfolkId`/`kinfolkName` it resolved from the
 * caller's number. The phone writes the same document from the FCM push that
 * pops the incoming-call screen.
 *
 * TWO DEFECTS, and neither is a deleted field - [CallLog] declares all fourteen:
 *
 *  1. NOT ATOMIC. The phone read the document with one `get()`, built a whole
 *     `CallLog` from it, and wrote that back with a bare `.set()`. A webhook
 *     landing in the gap between the read and the write was fully REVERTED -
 *     recording, duration, status, and the kinfolk match, all back to what the
 *     phone had read a moment earlier.
 *  2. `recordingUrl = popupUrl` UNCONDITIONALLY. The push carries a popup URL
 *     only sometimes; when it carried none, the phone wrote a blank over the
 *     recording URL Twilio had already stored. Losing the link to a call
 *     recording is not a cosmetic loss - there is no second copy of it here.
 *
 * The write mode is not asserted for its own sake. The recorded write is replayed
 * against a stored document using Firestore's real semantics, and the read is
 * asserted to happen through the SAME transaction as the write, which is what
 * closes the gap rather than merely narrowing it.
 */
class InboundCallLogUpsertTest {

    private val firestore = mockk<FirebaseFirestore>()
    private val collection = mockk<CollectionReference>()
    private val docRef = mockk<DocumentReference>()
    private val transaction = mockk<Transaction>()
    private val snapshot = mockk<DocumentSnapshot>()

    /** The write the repo issued inside the transaction, and its merge flag. */
    private data class RecordedWrite(val payload: Map<*, *>, val merge: Boolean)

    private var recorded: RecordedWrite? = null

    /** True if the repository ever read outside the transaction. */
    private var readOutsideTransaction = false

    private fun repo(existing: CallLog?): AuntieRepository {
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } returns Unit
        every { firestore.collection("calls_log") } returns collection
        every { collection.document(any()) } returns docRef

        every { snapshot.exists() } returns (existing != null)
        every { snapshot.toObject(CallLog::class.java) } returns existing
        every { transaction.get(docRef) } returns snapshot
        every { transaction.set(docRef, any(), any<SetOptions>()) } answers {
            recorded = RecordedWrite(secondArg<Any>() as Map<*, *>, merge = true)
            transaction
        }
        every { transaction.set(docRef, any()) } answers {
            recorded = RecordedWrite(mapOf("__whole_object__" to secondArg<Any>()), merge = false)
            transaction
        }
        // A read or a write that does not go through the transaction is the
        // defect, so both are stubbed to be caught rather than to blow up.
        every { docRef.get() } answers {
            readOutsideTransaction = true
            Tasks.forResult(snapshot)
        }
        every { docRef.set(any()) } answers {
            recorded = RecordedWrite(mapOf("__whole_object__" to firstArg<Any>()), merge = false)
            Tasks.forResult<Void>(null)
        }

        every { firestore.runTransaction(any<Transaction.Function<Unit>>()) } answers {
            Tasks.forResult(firstArg<Transaction.Function<Unit>>().apply(transaction))
        }

        return AuntieRepository(
            n8n = mockk<N8nApi>(),
            authGate = gate,
            functionsOverride = mockk(), // lazy; never resolved on a write path
            firestoreProvider = { firestore },
        )
    }

    private fun payload(): Map<*, *> =
        requireNotNull(recorded) { "the repository issued no document write at all" }.payload

    /**
     * Replays the recorded write against a stored document, as Firestore would.
     * `set(obj)` REPLACES the whole document; `set(obj, merge())` overlays only
     * the keys the payload carries.
     */
    private fun serverDocAfterWrite(stored: Map<String, Any>): Map<String, Any?> {
        val write = requireNotNull(recorded) { "the repository issued no document write at all" }
        val incoming = write.payload.entries.associate { it.key.toString() to it.value }
        return if (write.merge) stored + incoming else incoming
    }

    /** The document as the Twilio recording callback actually leaves it. */
    private fun storedCallDoc(): Map<String, Any> = mapOf(
        "counterpartNumber" to "+15125550147",
        "direction" to "inbound",
        "status" to "completed",
        "recordingUrl" to "https://api.twilio.com/recordings/RE123",
        "durationSec" to 96,
        "kinfolkId" to "kin-7",
        "kinfolkName" to "Nia Okafor",
        "timestamp" to "2026-08-09T18:00:00Z",
        "twilioCallSid" to CALL_SID,
    )

    private val twilioWrote = CallLog(
        id = CALL_SID,
        counterpartNumber = "+15125550147",
        direction = "inbound",
        status = "completed",
        recordingUrl = "https://api.twilio.com/recordings/RE123",
        durationSec = 96,
        kinfolkId = "kin-7",
        kinfolkName = "Nia Okafor",
        timestamp = "2026-08-09T18:00:00Z",
        twilioCallSid = CALL_SID,
    )

    private fun upsert(repo: AuntieRepository, popupUrl: String = "") = runBlocking {
        repo.upsertInboundCallLog(
            callSid = CALL_SID,
            callerNumber = "+15125550147",
            transcript = "Hi, calling about Tuesday",
            popupUrl = popupUrl,
        )
    }

    // ── defect 2: the blanked recording ───────────────────────────────────────

    @Test
    fun `a push carrying no popup url does not blank the recording Twilio wrote`() {
        val result = upsert(repo(twilioWrote))

        assertTrue(result.isSuccess)
        assertEquals(
            "https://api.twilio.com/recordings/RE123",
            serverDocAfterWrite(storedCallDoc())["recordingUrl"],
        )
    }

    @Test
    fun `a push that does carry a popup url still writes it`() {
        upsert(repo(null), popupUrl = "https://auntie.example/call/CA123").getOrThrow()

        assertEquals("https://auntie.example/call/CA123", payload()["recordingUrl"])
    }

    // ── defect 1: the reverted webhook ────────────────────────────────────────

    @Test
    fun `the read that decides the write happens inside the transaction`() {
        upsert(repo(twilioWrote)).getOrThrow()

        verify { firestore.runTransaction(any<Transaction.Function<Unit>>()) }
        verify { transaction.get(docRef) }
        assertFalse(
            "a read outside the transaction leaves the webhook a gap to land in",
            readOutsideTransaction,
        )
        assertTrue("the write must be the transaction's", requireNotNull(recorded).merge)
    }

    /**
     * The push knows the caller's number and what was said. It does not know the
     * call's outcome, its duration, or which kinfolk it belongs to - Twilio and
     * the server do. Restating those is how a webhook gets reverted.
     */
    @Test
    fun `the push writes only what the push knows`() {
        upsert(repo(twilioWrote)).getOrThrow()

        val keys = payload().keys.map { it.toString() }.toSet()
        assertEquals(
            setOf("counterpartNumber", "direction", "transcript", "twilioCallSid"),
            keys,
        )
    }

    @Test
    fun `the webhook's status, duration and kinfolk match all survive`() {
        upsert(repo(twilioWrote)).getOrThrow()

        val after = serverDocAfterWrite(storedCallDoc())
        assertEquals("completed", after["status"])
        assertEquals(96, after["durationSec"])
        assertEquals("kin-7", after["kinfolkId"])
        assertEquals("Nia Okafor", after["kinfolkName"])
        assertEquals("2026-08-09T18:00:00Z", after["timestamp"])
    }

    // ── the first sighting, where the push IS the only source ─────────────────

    @Test
    fun `a call the server has not seen yet is stamped ringing, now`() {
        upsert(repo(null)).getOrThrow()

        assertEquals("ringing", payload()["status"])
        assertTrue((payload()["timestamp"] as String).isNotBlank())
        assertEquals("Hi, calling about Tuesday", payload()["transcript"])
    }

    /**
     * A push can arrive without a CallSid. There is no document to converge on
     * then, so the call gets one of its own rather than being dropped or written
     * to a document named empty.
     */
    @Test
    fun `a blank CallSid still lands on a document of its own`() {
        val result = runBlocking {
            repo(null).upsertInboundCallLog(
                callSid = "",
                callerNumber = "+15125550147",
                transcript = "Hi, calling about Tuesday",
            )
        }

        assertTrue(result.isSuccess)
        val id = result.getOrThrow()
        assertTrue("a blank CallSid must not become a blank document id", id.isNotBlank())
        assertEquals("", payload()["twilioCallSid"])
    }

    private companion object {
        const val CALL_SID = "CA123"
    }
}
