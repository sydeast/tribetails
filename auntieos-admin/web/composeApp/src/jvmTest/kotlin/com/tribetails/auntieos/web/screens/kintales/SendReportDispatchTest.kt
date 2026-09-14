package com.tribetails.auntieos.web.screens.kintales

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Slice 5 desktop send-path integration: FirestoreClient.sendReport dispatches the
 * `report_sent` notification via platformInvokeCallable (answered on jvm by
 * JvmFirestoreFixtures.callableResponses) before stamping the report SENT. Covers
 * the fail-loud routing guards + a dispatch error (which must block the SENT flip
 * so the auntie retries, never silently send with an empty receipt). The
 * dispatch-success -> Firestore-mark write is exercised at the VM level against
 * the in-memory fake (KinTaleReportViewModelTest); here we pin the dispatch leg.
 *
 * NOTE-53: also pins the batchId+visitId vs legacy bookingId routing selection that
 * mirrors Android VisitNotifier: prefer envelope IDs when both present+non-blank,
 * fall back to sourceBookingId, never send a blank/malformed id.
 */
class SendReportDispatchTest {

    // A minimal dispatch-ok response (no dispatchIds = suppressed, which is fine for
    // these tests — we only care about the payload shape, not the delivery outcome).
    private val dispatchOkJson = """{"ok":true,"dispatchIds":[],"suppressed":true}"""

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.clear()
    }

    private fun report() = KinCareReport(_id = "report-1", sessionId = "sess-1", bodyCopy = "Great visit!")
    private fun session(
        kinfolkId: String = "kf-1",
        bookingId: String = "bk-1",
        batchId: String? = null,
        visitId: String? = null,
    ) = KinCareSession(
        _id = "sess-1",
        kinfolkId = kinfolkId,
        sourceBookingId = bookingId,
        kinCareBatchId = batchId,
        kinCareVisitId = visitId,
    )

    // ── guard tests (unchanged behaviour) ────────────────────────────────────

    @Test
    fun blankKinfolkIdFailsLoudWithoutDispatch() = runBlocking {
        // No callable fixture set: if it tried to dispatch, the network call would
        // fail differently. The guard returns its own message synchronously.
        val r = FirestoreClient().sendReport(report(), session(kinfolkId = ""))
        assertTrue(r is WriteResult.Err)
        assertTrue((r as WriteResult.Err).message.contains("kinfolk"))
    }

    @Test
    fun blankBookingIdFailsLoudWithoutDispatch() = runBlocking {
        val r = FirestoreClient().sendReport(report(), session(bookingId = ""))
        assertTrue(r is WriteResult.Err)
        assertTrue((r as WriteResult.Err).message.contains("booking-originated"))
    }

    @Test
    fun requireSavedReportIdBeforeSending() = runBlocking {
        val ex = runCatching {
            FirestoreClient().sendReport(report().copy(_id = ""), session())
        }.exceptionOrNull()
        // require(...) on a blank report id throws IllegalArgumentException.
        assertEquals(IllegalArgumentException::class, ex!!::class)
    }

    // ── NOTE-53: routing-selection tests ─────────────────────────────────────

    /**
     * When the session has no kinCareBatchId/kinCareVisitId, the legacy bookingId
     * must appear in the payload and batchId/visitId must NOT be present.
     */
    @Test
    fun legacySession_sendsBookingId_notEnvelopeIds() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("dispatchVisitNotification" to dispatchOkJson)
        FirestoreClient().sendReport(report(), session(bookingId = "bk-legacy"))

        val payload = lastDispatchPayload()
        assertEquals("bk-legacy", payload["bookingId"]?.jsonPrimitive?.content)
        assertNull(payload["batchId"], "Legacy path must NOT send batchId")
        assertNull(payload["visitId"], "Legacy path must NOT send visitId")
    }

    /**
     * When the session carries both kinCareBatchId and kinCareVisitId, the server-
     * preferred envelope form (batchId+visitId) must be sent and bookingId must NOT
     * appear — mirrors Android VisitNotifier exactly.
     */
    @Test
    fun envelopeSession_sendsBatchIdAndVisitId_notBookingId() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("dispatchVisitNotification" to dispatchOkJson)
        FirestoreClient().sendReport(
            report(),
            session(bookingId = "bk-old", batchId = "batch-42", visitId = "visit-7"),
        )

        val payload = lastDispatchPayload()
        assertEquals("batch-42", payload["batchId"]?.jsonPrimitive?.content)
        assertEquals("visit-7", payload["visitId"]?.jsonPrimitive?.content)
        assertNull(payload["bookingId"], "Envelope path must NOT send bookingId")
    }

    /**
     * Only batchId present (visitId missing) → fall back to legacy bookingId.
     * Both envelope IDs must be present and non-blank to use the preferred form.
     */
    @Test
    fun partialEnvelopeIds_batchIdOnly_fallsBackToLegacy() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("dispatchVisitNotification" to dispatchOkJson)
        FirestoreClient().sendReport(
            report(),
            session(bookingId = "bk-fallback", batchId = "batch-42", visitId = null),
        )

        val payload = lastDispatchPayload()
        assertEquals("bk-fallback", payload["bookingId"]?.jsonPrimitive?.content)
        assertNull(payload["batchId"])
        assertNull(payload["visitId"])
    }

    /**
     * Only visitId present (batchId missing) → fall back to legacy bookingId.
     */
    @Test
    fun partialEnvelopeIds_visitIdOnly_fallsBackToLegacy() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("dispatchVisitNotification" to dispatchOkJson)
        FirestoreClient().sendReport(
            report(),
            session(bookingId = "bk-fallback2", batchId = null, visitId = "visit-7"),
        )

        val payload = lastDispatchPayload()
        assertEquals("bk-fallback2", payload["bookingId"]?.jsonPrimitive?.content)
        assertNull(payload["batchId"])
        assertNull(payload["visitId"])
    }

    /**
     * Blank (not null) envelope IDs must be treated as absent — blank strings are
     * not valid IDs and the server would route incorrectly. Fall back to legacy.
     */
    @Test
    fun blankEnvelopeIds_treatedAsAbsent_fallsBackToLegacy() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("dispatchVisitNotification" to dispatchOkJson)
        FirestoreClient().sendReport(
            report(),
            session(bookingId = "bk-blank-guard", batchId = "", visitId = ""),
        )

        val payload = lastDispatchPayload()
        assertEquals("bk-blank-guard", payload["bookingId"]?.jsonPrimitive?.content)
        assertNull(payload["batchId"])
        assertNull(payload["visitId"])
    }

    /**
     * Neither envelope IDs nor sourceBookingId — must fail loud without dispatching.
     */
    @Test
    fun noEnvelopeNoBookingId_failsLoud() = runBlocking {
        // No callable response — if it dispatched we'd get a network error with a
        // different message. The guard fires before any network call.
        val r = FirestoreClient().sendReport(
            report(),
            session(bookingId = "", batchId = null, visitId = null),
        )
        assertTrue(r is WriteResult.Err)
        assertTrue((r as WriteResult.Err).message.contains("booking-originated"))
    }

    /**
     * familyId must be in the payload regardless of which routing form is used.
     */
    @Test
    fun familyIdAlwaysPresentInPayload() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("dispatchVisitNotification" to dispatchOkJson)
        FirestoreClient().sendReport(
            report(),
            session(kinfolkId = "kf-99", batchId = "b1", visitId = "v1"),
        )
        assertEquals("kf-99", lastDispatchPayload()["familyId"]?.jsonPrimitive?.content)
    }

    /**
     * #832: the report id rides in the payload, so the server can tell a second
     * KinTale for the same visit from a retry of this one.
     */
    @Test
    fun reportIdIsInPayloadSoEachReportIsItsOwnNotification() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("dispatchVisitNotification" to dispatchOkJson)
        FirestoreClient().sendReport(report(), session(batchId = "b1", visitId = "v1"))
        assertEquals("report-1", lastDispatchPayload()["reportId"]?.jsonPrimitive?.content)

        FirestoreClient().sendReport(report().copy(_id = "report-2"), session(batchId = "b1", visitId = "v1"))
        assertEquals("report-2", lastDispatchPayload()["reportId"]?.jsonPrimitive?.content)
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    /** Parse the last captured callable payload as a JsonObject for assertions. */
    private fun lastDispatchPayload() = Json.parseToJsonElement(
        requireNotNull(JvmFirestoreFixtures.lastCallablePayloadJson) {
            "No callable was invoked — check that callableResponses is set before calling sendReport"
        }
    ).jsonObject
}
