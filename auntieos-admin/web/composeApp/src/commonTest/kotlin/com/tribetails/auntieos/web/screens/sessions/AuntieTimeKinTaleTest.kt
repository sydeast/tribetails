package com.tribetails.auntieos.web.screens.sessions

import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.screens.booking.NewBookingMath
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #2123 on the console's Auntie Time board. A visit is Completed at departure,
 * so the write-up moved off the DEPARTED card: any DEPARTED or COMPLETED card
 * with no sent KinTale offers "Send the KinTale", a sent one "View KinTale".
 * Complete no longer waits on a KinTale. With "KinTale required" on, a
 * completed visit the server marked due sits in "KinTales to send", however
 * old, and not in Recent as well.
 */
class AuntieTimeKinTaleTest {

    private val zone = NewBookingMath.businessTimeZone(null)
    private val today = "2026-11-12"

    private fun visit(
        id: String = "s1",
        status: String,
        startTime: String = "2026-11-12T15:00:00Z",
        due: Boolean = false,
        sentReportCount: Int = 0,
        reportIds: List<String> = emptyList(),
        arrivedAt: String = "2026-11-12T15:00:00Z",
        departedAt: String = "2026-11-12T16:00:00Z",
    ) = KinCareSession(
        _id = id,
        status = status,
        startTime = startTime,
        kinTaleDue = due,
        sentReportCount = sentReportCount,
        reportIds = reportIds,
        arrivedAt = arrivedAt,
        departedAt = departedAt,
    )

    // ── What a card offers for the KinTale ──────────────────────────────────

    @Test
    fun aDepartedOrCompletedCardWithNoSentKinTaleOffersSendTheKinTale() {
        assertEquals(KinTaleCardAction.Send, kinTaleCardAction(visit(status = "DEPARTED")))
        assertEquals(KinTaleCardAction.Send, kinTaleCardAction(visit(status = "COMPLETED")))
        // Required or not, the write-up is offered: the task list is the extra.
        assertEquals(KinTaleCardAction.Send, kinTaleCardAction(visit(status = "COMPLETED", due = true)))
    }

    @Test
    fun aSentKinTaleIsViewedNeverWrittenAgain() {
        assertEquals(KinTaleCardAction.View, kinTaleCardAction(visit(status = "COMPLETED", sentReportCount = 1, reportIds = listOf("r1"))))
        assertEquals(KinTaleCardAction.View, kinTaleCardAction(visit(status = "DEPARTED", sentReportCount = 1, reportIds = listOf("r1"))))
    }

    @Test
    fun aSavedDraftStillOffersSendTheKinTale() {
        // A draft's id is on reportIds (Android's createKinCareReport) with nothing sent.
        assertEquals(KinTaleCardAction.Send, kinTaleCardAction(visit(status = "COMPLETED", reportIds = listOf("draft-1"))))
    }

    @Test
    fun aSendWithNoReportIdToOpenOffersNeitherButton() {
        assertEquals(KinTaleCardAction.None, kinTaleCardAction(visit(status = "COMPLETED", sentReportCount = 1)))
    }

    @Test
    fun aVisitNotYetDepartedOrCalledOffOffersNoKinTaleButton() {
        for (status in listOf("SCHEDULED", "ON_MY_WAY", "ARRIVED", "CANCELLED")) {
            assertEquals(KinTaleCardAction.None, kinTaleCardAction(visit(status = status, sentReportCount = 1)), status)
            assertEquals(KinTaleCardAction.None, kinTaleCardAction(visit(status = status)), status)
        }
    }

    // ── The board ───────────────────────────────────────────────────────────

    @Test
    fun anOwedVisitIsInKinTalesToSendAndNotAlsoInRecent() {
        val owed = visit(status = "COMPLETED", due = true)
        val board = auntieTimeBoard(listOf(owed), today, zone, kinTaleRequired = true)
        assertEquals(listOf(owed), board[AuntieTimePhase.KinTalesToSend])
        assertNull(board[AuntieTimePhase.CompletedToday])
    }

    @Test
    fun anOwedVisitOlderThanRecentStillShowsUntilItsKinTaleIsSent() {
        val old = visit(status = "COMPLETED", startTime = "2026-10-01T15:00:00Z", due = true)
        val board = auntieTimeBoard(listOf(old), today, zone, kinTaleRequired = true)
        assertEquals(listOf(old), board[AuntieTimePhase.KinTalesToSend])
        // The same visit once its KinTale is sent is history and leaves the board.
        val sent = old.copy(sentReportCount = 1, reportIds = listOf("r1"))
        assertTrue(auntieTimeBoard(listOf(sent), today, zone, kinTaleRequired = true).isEmpty())
    }

    @Test
    fun withTheSettingOffNoGroupAppearsAndTheVisitIsRecentAsBefore() {
        val owed = visit(status = "COMPLETED", due = true)
        val old = visit(id = "s2", status = "COMPLETED", startTime = "2026-10-01T15:00:00Z", due = true)
        val board = auntieTimeBoard(listOf(owed, old), today, zone, kinTaleRequired = false)
        assertNull(board[AuntieTimePhase.KinTalesToSend])
        assertEquals(listOf(owed), board[AuntieTimePhase.CompletedToday])
    }

    @Test
    fun aCompletedVisitTheServerNeverMarkedDueIsRecentNotATask() {
        val done = visit(status = "COMPLETED")
        val board = auntieTimeBoard(listOf(done), today, zone, kinTaleRequired = true)
        assertNull(board[AuntieTimePhase.KinTalesToSend])
        assertEquals(listOf(done), board[AuntieTimePhase.CompletedToday])
    }

    @Test
    fun aDepartedVisitStaysActiveWhileTheServerCompletesIt() {
        val departed = visit(status = "DEPARTED", due = true)
        val board = auntieTimeBoard(listOf(departed), today, zone, kinTaleRequired = true)
        assertEquals(listOf(departed), board[AuntieTimePhase.Active])
        assertNull(board[AuntieTimePhase.KinTalesToSend])
    }

    @Test
    fun kinTalesToSendSitsRightAfterActive() {
        assertEquals(
            listOf(
                AuntieTimePhase.Active,
                AuntieTimePhase.KinTalesToSend,
                AuntieTimePhase.Overdue,
                AuntieTimePhase.Upcoming,
                AuntieTimePhase.CompletedToday,
            ),
            AuntieTimePhase.entries.toList(),
        )
        assertEquals("KinTales to send", AuntieTimePhase.KinTalesToSend.label)
    }

    // ── Departing and completing ────────────────────────────────────────────

    @Test
    fun departingSaysTheVisitIsMarkedCompleted() {
        assertEquals("Departed. GPS saved. The visit is marked Completed.", kinCareSuccessMessage(AuntieTimeAction.Departed))
        // The clock patch itself is unchanged: the server completes the visit.
        assertEquals(
            mapOf("status" to "DEPARTED", "departedAt" to "2026-11-12T16:00:00Z"),
            kinCarePatch(visit(status = "ARRIVED"), AuntieTimeAction.Departed, "2026-11-12T16:00:00Z"),
        )
    }

    private class Captured {
        var refused: String? = null
        var id: String? = null
        var write: KinCareWrite? = null
        var message: String? = null
    }

    private fun complete(session: KinCareSession, arrivalRule: Boolean?): Captured {
        val c = Captured()
        markCompleted(
            session = session,
            arrivalRule = arrivalRule,
            onRefused = { c.refused = it },
            onWrite = { id, write, msg -> c.id = id; c.write = write; c.message = msg },
            now = "2026-11-12T18:00:00Z",
        )
        return c
    }

    @Test
    fun completeOnADepartedCardWithNoKinTaleGoesThroughTransitionBookingStatus() {
        val c = complete(visit(status = "DEPARTED"), arrivalRule = true)
        assertNull(c.refused)
        assertEquals("s1", c.id)
        assertEquals(KinCareWrite.Transition("COMPLETE", completedAt = "2026-11-12T18:00:00Z"), c.write)
        assertEquals("Marked Completed.", c.message)
    }

    @Test
    fun completeIsRefusedLocallyWhenTheArrivalRuleIsCertainToRefuseIt() {
        val c = complete(visit(status = "DEPARTED", arrivedAt = ""), arrivalRule = true)
        assertNull(c.write)
        assertTrue(c.refused!!.startsWith("This visit has no arrival recorded"))
    }

    @Test
    fun anUnknownArrivalRuleLeavesTheDecisionToTheServer() {
        val c = complete(visit(status = "DEPARTED", arrivedAt = "", departedAt = ""), arrivalRule = null)
        assertNull(c.refused)
        assertEquals(KinCareWrite.Transition("COMPLETE", completedAt = "2026-11-12T18:00:00Z"), c.write)
    }
}
