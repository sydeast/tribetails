package com.tribetails.auntieos.web.screens.sessions

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.visitStepNoticeId
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull

/**
 * #1840, then #2037, on the desktop console: the toast says what the household
 * was told about a clock step.
 *
 * #2037: THE CONSOLE NO LONGER TELLS THE HOUSEHOLD. It used to call
 * `dispatchVisitNotification` after its patch, so a console closed in between
 * kept the step and lost the notice. The server sends it from the committed
 * write and records the outcome at `visit_step_notices/{id}`; the console
 * reads that record. These cases hand [FirestoreClient.visitClockNoticeRecord]
 * the records by id and assert no callable is made at all.
 */
class VisitClockNoticeTest {

    private val session = KinCareSession(
        _id = "dre1",
        kinfolkId = "kfDre",
        kinfolkName = "Dre East",
        kinCareBatchId = "b1",
        kinCareVisitId = "v1",
    )
    private val at = "2026-11-10T23:40:00Z"
    private val atMs = 1_794_354_000_000L

    /** The server's records, by id. */
    private val records = mutableMapOf<String, JsonObject>()
    /** Every record id the console asked for. */
    private val asked = mutableListOf<String>()

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.clear()
        records.clear()
        asked.clear()
    }

    private fun record(event: String, notified: Boolean, reason: String?, s: KinCareSession = session) {
        records[visitStepNoticeId(s._id, event, atMs)] = JsonObject(
            buildMap {
                put("notified", JsonPrimitive(notified))
                if (reason != null) put("reason", JsonPrimitive(reason))
            },
        )
    }

    /** One clock step end to end, as the screen runs it. */
    private fun tap(action: AuntieTimeAction, s: KinCareSession = session): String = runBlocking {
        val notice = visitNoticeEventOf(kinCarePatch(s, action, at)) ?: return@runBlocking ""
        val outcome = clockNoticeOutcome(s, notice) { event, ms ->
            FirestoreClient().visitClockNoticeRecord(s, event, ms, waitMs = 0L, pollMs = 1L) { id ->
                asked += id
                records[id]
            }
        }
        visitNoticeOutcomeSentence(outcome, visitNoticeHousehold(s))
    }

    // ── the three cases the result line must tell the truth about ────────────

    @Test
    fun aHouseholdThatWasToldReadsNotified() {
        record("on_my_way", notified = true, reason = null)
        assertEquals("Dre East was notified.", tap(AuntieTimeAction.OnMyWay))
    }

    @Test
    fun aHouseholdWithNoPortalSignInReadsNotNotifiedAndWhy() {
        // The Nov 10 walk: nobody has claimed the household, whatever login its record carries.
        record("on_my_way", notified = false, reason = "household_has_no_portal_account")
        assertEquals(
            "Dre East was not notified, because they have no portal account.",
            tap(AuntieTimeAction.OnMyWay),
        )
    }

    @Test
    fun householdNoticesSwitchedOffReadsNotNotifiedAndWhy() {
        record("arrived", notified = false, reason = "household_notices_off")
        assertEquals(
            "Dre East was not notified, because notices to households are off in Settings.",
            tap(AuntieTimeAction.Arrived),
        )
    }

    // ── #2037: what is read, and that nothing is sent ────────────────────────

    @Test
    fun eachStepReadsItsOwnRecordAndCallsNothing() {
        for ((action, wire) in listOf(
            AuntieTimeAction.OnMyWay to "on_my_way",
            AuntieTimeAction.Arrived to "arrived",
            AuntieTimeAction.Departed to "departed",
        )) {
            record(wire, notified = true, reason = null)
            assertEquals("Dre East was notified.", tap(action))
            assertEquals("dre1__${wire}__$atMs", asked.last())
        }
        assertNull(JvmFirestoreFixtures.lastCallableName)
    }

    @Test
    fun noRecordInTimeIsStillCheckingNeverNotTold() {
        assertEquals("Still checking whether Dre East was told.", tap(AuntieTimeAction.Arrived))
        assertNull(JvmFirestoreFixtures.lastCallableName)
    }

    @Test
    fun aRecordThatLandsWhileWaitingIsRead() = runBlocking {
        var reads = 0
        val res = FirestoreClient().visitClockNoticeRecord(session, "arrived", atMs, waitMs = 10L, pollMs = 1L) {
            reads += 1
            if (reads < 3) null else JsonObject(mapOf("notified" to JsonPrimitive(true)))
        }
        assertEquals(VisitNotifyOutcome(notified = true, notifySkipped = null), visitNotifyOutcomeOf(res))
    }

    @Test
    fun aReadThatFailsKeepsWaitingAndNeverFailsTheTap() = runBlocking {
        val res = FirestoreClient().visitClockNoticeRecord(session, "arrived", atMs, waitMs = 2L, pollMs = 1L) {
            error("Firestore 403")
        }
        assertEquals(VisitNotifyOutcome(notified = false, notifySkipped = "notice_pending"), visitNotifyOutcomeOf(res))
    }

    // ── steps and rows that tell nobody ──────────────────────────────────────

    @Test
    fun undoArrivedTellsNobodyAndReadsNothing() {
        assertNull(visitNoticeEventOf(kinCarePatch(session.copy(onMyWayAt = at), AuntieTimeAction.UndoArrived, at)))
        assertNull(visitNoticeEventOf(kinCarePatch(session, AuntieTimeAction.UndoArrived, at)))
        assertEquals("", tap(AuntieTimeAction.UndoArrived, session.copy(onMyWayAt = at)))
        assertEquals(emptyList<String>(), asked)
    }

    @Test
    fun aVisitWithNoHouseholdOrNoBookingIsNamedWithoutARead() {
        assertEquals(
            "No household was notified, because this visit is not linked to one.",
            tap(AuntieTimeAction.OnMyWay, KinCareSession(_id = "s")),
        )
        assertEquals(
            "Dre East was not notified, because this visit is not linked to a booking.",
            tap(AuntieTimeAction.OnMyWay, KinCareSession(_id = "s", kinfolkId = "kf1", kinfolkName = "Dre East")),
        )
        assertEquals(emptyList<String>(), asked)
    }

    @Test
    fun aRecordWithNoReasonNamesNoCause() {
        record("departed", notified = false, reason = null)
        assertEquals("Dre East was not notified.", tap(AuntieTimeAction.Departed))
    }

    // ── errors and older servers ─────────────────────────────────────────────

    @Test
    fun anAnswerThatIsNotAnObjectIsAFailedSendNotAPromise() {
        assertEquals(
            VisitNotifyOutcome(notified = false, notifySkipped = "dispatch_failed"),
            visitNotifyOutcomeOf(WriteResult.Ok("not json")),
        )
    }

    @Test
    fun aSuppressedAnswerWithNoReasonNamesNoCause() {
        assertEquals(
            VisitNotifyOutcome(notified = false, notifySkipped = "not_sent"),
            visitNotifyOutcomeOf(WriteResult.Ok("""{"ok":true,"dispatchIds":[],"suppressed":true}""")),
        )
        assertEquals(
            VisitNotifyOutcome(notified = false, notifySkipped = "not_sent"),
            visitNotifyOutcomeOf(WriteResult.Ok("""{"ok":true,"dispatchIds":[],"suppressed":true,"reason":null}""")),
        )
        assertEquals("Dre East was not notified.", visitNoticeOutcomeSentence(VisitNotifyOutcome(false, "not_sent"), "Dre East"))
    }

    @Test
    fun theOtherReasonsReadInPlainWords() {
        fun said(reason: String) = visitNoticeOutcomeSentence(VisitNotifyOutcome(false, reason), "the Wrens")
        assertEquals("The Wrens was not notified, because this notice is turned off for them.", said("household_prefs_suppressed"))
        assertEquals("The Wrens was already told about this step, so it was not sent again.", said("already_notified"))
        assertEquals("The Wrens was not notified.", said("a_reason_from_a_newer_server"))
        for (reason in listOf("household_has_no_portal_account", "household_notices_off", "dispatch_failed")) {
            assertFalse(said(reason).contains('—'))
        }
    }

    @Test
    fun aVisitWithNoHouseholdNameSaysTheHousehold() {
        assertEquals("the household", visitNoticeHousehold(KinCareSession(_id = "s", kinfolkName = "  ")))
    }
}
