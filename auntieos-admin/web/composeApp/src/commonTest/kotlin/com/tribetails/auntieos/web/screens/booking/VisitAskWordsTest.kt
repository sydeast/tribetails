package com.tribetails.auntieos.web.screens.booking

import com.tribetails.auntieos.web.data.AskDecision
import com.tribetails.auntieos.web.data.CancelAsk
import com.tribetails.auntieos.web.data.CancelAskAnswer
import com.tribetails.auntieos.web.data.RescheduleAsk
import com.tribetails.auntieos.web.data.RescheduleAskAnswer
import com.tribetails.auntieos.web.data.ScheduleOverride
import com.tribetails.auntieos.web.data.decodeCancelAskAnswer
import com.tribetails.auntieos.web.data.decodeCancelAsks
import com.tribetails.auntieos.web.data.decodeRescheduleAskAnswer
import com.tribetails.auntieos.web.data.decodeRescheduleAsks
import com.tribetails.auntieos.web.data.resolveCancelAskPayload
import com.tribetails.auntieos.web.data.resolveRescheduleAskPayload
import com.tribetails.auntieos.web.screens.ServiceCatalog
import kotlinx.datetime.TimeZone
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #2243: the move and cancellation asks the console now lists on Bookings. The
 * shapes are the server's `RescheduleRequestDto` / `CancelRequestDto`; the words
 * are admin web's `VisitRequestsSection`.
 */
class VisitAskWordsTest {
    private val chicago = TimeZone.of("America/Chicago")

    // 2026-11-25T20:00:00Z is 14:00 in Chicago; 2026-11-26T15:30:00Z is 09:30.
    private val nov25at14 = 1_795_636_800_000L
    private val nov26at0930 = 1_795_707_000_000L

    private val move = RescheduleAsk(
        kinfolkId = "kf1", batchId = "b1", visitId = "v1",
        kinfolkName = "The Wrens", serviceType = "visit_60", kinNames = listOf("Biscuit", " "),
        currentStartTimeMs = nov25at14, proposedStartTimeMs = nov26at0930,
        reason = "Flight moved", requestedAtMs = 2_000L,
    )
    private val cancel = CancelAsk(
        kinfolkId = "kf2", batchId = "b2", visitId = "v2",
        kinfolkName = null, title = "Drop-in", startTimeMs = nov25at14, requestedAtMs = 3_000L,
    )

    @Test
    fun decodesBothListsAndDropsRowsThatCannotBeAnswered() {
        val moves = decodeRescheduleAsks(
            """{"requests":[
              {"kinfolkId":"kf1","batchId":"b1","visitId":"v1","kinfolkName":"The Wrens","title":null,
               "serviceType":"visit_60","kinNames":["Biscuit"],"status":"scheduled",
               "currentStartTimeMs":1795636800000,"currentEndTimeMs":null,
               "proposedStartTimeMs":1795707000000,"proposedEndTimeMs":null,
               "reason":"Flight moved","requestedAtMs":2000,"extra":"ignored"},
              {"kinfolkId":"kf1","batchId":"","visitId":"v9"}
            ]}""",
        )
        assertEquals(1, moves.size, "a row with no booking id cannot be answered, so it is left out")
        assertEquals(move.copy(kinNames = listOf("Biscuit")), moves.single())

        val cancels = decodeCancelAsks(
            """{"requests":[{"kinfolkId":"kf2","batchId":"b2","visitId":"v2","kinfolkName":null,"title":"Drop-in",
              "serviceType":null,"kinNames":[],"status":null,"startTimeMs":1795636800000,"endTimeMs":null,
              "reason":null,"requestedAtMs":3000}]}""",
        )
        assertEquals(listOf(cancel), cancels)
    }

    @Test
    fun aBodyWithNoListIsAFailedReadNotAnEmptyQueue() {
        assertFailsWith<IllegalStateException> { decodeRescheduleAsks("""{"ok":true}""") }
        assertFailsWith<IllegalStateException> { decodeCancelAsks("{}") }
    }

    @Test
    fun answersReadWhatTheServerDid() {
        assertEquals(
            RescheduleAskAnswer("accept", sessionUpdated = true),
            decodeRescheduleAskAnswer("""{"ok":true,"visitId":"v1","decision":"accept","startTimeMs":1,"sessionUpdated":true}"""),
        )
        assertEquals(
            CancelAskAnswer("decline", sessionUpdated = false),
            decodeCancelAskAnswer("""{"ok":true,"visitId":"v2","decision":"decline","status":null,"sessionUpdated":false,"rescheduleRequestClosed":false}"""),
        )
    }

    @Test
    fun theNoteGoesOnlyWithWordsInItAndOverridesOnlyWhenChosen() {
        val bare = resolveRescheduleAskPayload(move, AskDecision.ACCEPT, "   ")
        assertEquals("kf1", bare["kinfolkId"]!!.jsonPrimitive.content)
        assertEquals("b1", bare["batchId"]!!.jsonPrimitive.content)
        assertEquals("v1", bare["visitId"]!!.jsonPrimitive.content)
        assertEquals("accept", bare["decision"]!!.jsonPrimitive.content)
        assertNull(bare["note"])
        assertNull(bare["overrideBusyConflict"])
        assertNull(bare["overrideVisitConflict"])

        val both = resolveRescheduleAskPayload(move, AskDecision.ACCEPT, "  See you then.  ", setOf(ScheduleOverride.BUSY, ScheduleOverride.VISIT))
        assertEquals("See you then.", both["note"]!!.jsonPrimitive.content)
        assertEquals("true", both["overrideBusyConflict"]!!.jsonPrimitive.content)
        assertEquals("true", both["overrideVisitConflict"]!!.jsonPrimitive.content)

        val declined = resolveCancelAskPayload(cancel, AskDecision.DECLINE, "x".repeat(600))
        assertEquals("decline", declined["decision"]!!.jsonPrimitive.content)
        assertEquals(500, declined["note"]!!.jsonPrimitive.content.length, "capped at the server's 500")
        assertFalse("overrideBusyConflict" in declined)
    }

    @Test
    fun newestAskFirstAndAnUndatedAskLast() {
        val undated = move.copy(visitId = "v3", requestedAtMs = null)
        val rows = mergeVisitAsks(listOf(move, undated), listOf(cancel))
        assertEquals(listOf("cancel/kf2/b2/v2", "reschedule/kf1/b1/v1", "reschedule/kf1/b1/v3"), rows.map { it.key() })
    }

    @Test
    fun timesAreOnTheBusinessClockIn24HourForm() {
        assertEquals("Nov 25, 2026 14:00", askTimeLabel(nov25at14, chicago))
        assertEquals("Not set", askTimeLabel(null, chicago))
        assertEquals("Nov 25, 2026 14:00 → Nov 26, 2026 09:30", VisitAsk.Reschedule(move).whenLine(chicago))
    }

    @Test
    fun theRowNamesTheHouseholdAndTheKinCareNeverAnId() {
        val catalog = ServiceCatalog(serviceRates = mapOf("Visit 60" to "40"))
        val m = VisitAsk.Reschedule(move)
        val c = VisitAsk.Cancel(cancel)
        assertEquals("Reschedule", m.kindLabel())
        assertEquals("Cancel", c.kindLabel())
        assertEquals("The Wrens", m.householdLabel())
        assertEquals("Household name not on file", c.householdLabel())
        assertEquals("Visit 60 · Biscuit", m.subject(catalog))
        assertEquals("Drop-in", c.subject(catalog))
        assertEquals("Reschedule from The Wrens", m.detailTitle())
        assertEquals("Cancel", c.detailTitle())
    }

    @Test
    fun theConfirmStepSaysWhatWillHappen() {
        val m = VisitAsk.Reschedule(move)
        val c = VisitAsk.Cancel(cancel.copy(kinfolkName = "The Fenns"))
        assertEquals("Move this visit for The Wrens", m.decisionTitle(AskDecision.ACCEPT))
        assertEquals("Decline this new time from The Wrens", m.decisionTitle(AskDecision.DECLINE))
        assertEquals("Cancel this visit for The Fenns", c.decisionTitle(AskDecision.ACCEPT))
        assertEquals("Keep this visit for The Fenns", c.decisionTitle(AskDecision.DECLINE))
        assertEquals("This visit will move from Nov 25, 2026 14:00 to Nov 26, 2026 09:30.", m.decisionLine(AskDecision.ACCEPT, chicago))
        assertEquals("Nov 26, 2026 09:30 will not be booked. The visit stays at Nov 25, 2026 14:00.", m.decisionLine(AskDecision.DECLINE, chicago))
        assertEquals("Nov 25, 2026 14:00 will be taken off the schedule and off the household's portal.", c.decisionLine(AskDecision.ACCEPT, chicago))
        assertEquals("Nov 25, 2026 14:00 stays on the schedule. The household will be told it is going ahead.", c.decisionLine(AskDecision.DECLINE, chicago))
        assertEquals("Move it", m.confirmLabel(AskDecision.ACCEPT))
        assertEquals("Cancel it", c.confirmLabel(AskDecision.ACCEPT))
        assertEquals("Send the decline", c.confirmLabel(AskDecision.DECLINE))
        assertEquals("Anything to add for the household (optional)", askNoteLabel(AskDecision.DECLINE))
        assertEquals("Note for the household (optional)", askNoteLabel(AskDecision.ACCEPT))
    }

    @Test
    fun theOutcomeReportsWhatTheServerDid() {
        assertEquals("Moved. The schedule and the household now show the new time.",
            rescheduleAnsweredMessage(AskDecision.ACCEPT, RescheduleAskAnswer("accept", true)))
        assertEquals("Moved. This visit is still a request, so it has no schedule row to move yet.",
            rescheduleAnsweredMessage(AskDecision.ACCEPT, RescheduleAskAnswer("accept", false)))
        assertEquals("Declined. The household will see your answer on their booking.",
            rescheduleAnsweredMessage(AskDecision.DECLINE, RescheduleAskAnswer("decline", false)))
        assertEquals("Cancelled. It is off the schedule and off the household’s portal.",
            cancelAnsweredMessage(AskDecision.ACCEPT, CancelAskAnswer("accept", true)))
        assertEquals("Cancelled. This visit was still a request, so it had no schedule row to take off.",
            cancelAnsweredMessage(AskDecision.ACCEPT, CancelAskAnswer("accept", false)))
        assertEquals("Declined. The visit stays on the schedule and the household gets your answer.",
            cancelAnsweredMessage(AskDecision.DECLINE, CancelAskAnswer("decline", false)))
        assertEquals("The Wrens: Declined.", VisitAsk.Reschedule(move).outcomeLine("Declined."))
    }

    @Test
    fun aFailedQueueSaysSoAndNeverReadsAsEmpty() {
        val state = VisitAskQueueState()
        assertTrue(state.needsPanel, "before any answer the queue is still being read")
        state.reschedule = listOf(move)
        state.cancelError = "Admin claim required."
        assertTrue(state.settled)
        assertEquals(listOf("Cancellation requests: Admin claim required."), state.failures)
        assertEquals(
            "Cancellation requests: Admin claim required. Anything waiting there is not on this list.",
            askQueueFailureText(state.failures),
        )
        assertEquals(1, state.rows.size)
        state.markAnswered(state.rows.single(), "Declined.")
        assertTrue(state.rows.isEmpty())
        assertEquals("The Wrens: Declined.", state.outcome)
        assertTrue(state.needsPanel, "the outcome and the failed queue stay on screen")
        state.active = false
        assertFalse(state.needsPanel)
    }
}
