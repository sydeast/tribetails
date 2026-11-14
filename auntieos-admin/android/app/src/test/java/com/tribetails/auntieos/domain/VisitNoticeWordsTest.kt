package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.notifications.VisitNotifier
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1794: the words the Auntie reads about the household, before and after a
 * clock tap. The same sentences as web's `lib/visitNotice.ts`
 * (`visitNotice.test.ts` pins them there), so the two apps say the same thing.
 */
class VisitNoticeWordsTest {

    private val routed = KinCareSession(id = "s1", kinfolkId = "kf1", kinCareBatchId = "b1", kinCareVisitId = "v1")

    private fun said(notified: Boolean, skipped: String?, name: String = "Dre East") =
        visitNoticeOutcomeSentence(VisitNotifyOutcome(notified, skipped), name)

    @Test
    fun `each outcome reads in plain words`() {
        assertEquals("Dre East was notified.", said(true, null))
        assertEquals(
            "Dre East was not notified, because they have no portal account.",
            said(false, "household_has_no_portal_account"),
        )
        assertEquals(
            "Dre East was not notified, because notices to households are off in Settings.",
            said(false, "household_notices_off"),
        )
        assertEquals(
            "Dre East was not notified, because this notice is turned off for them.",
            said(false, "household_prefs_suppressed"),
        )
        assertEquals(
            "Dre East was already told about this step, so it was not sent again.",
            said(false, "already_notified"),
        )
        assertEquals(
            "Dre East was not notified, because this visit is not linked to a booking.",
            said(false, "session_has_no_routing_ids"),
        )
        assertEquals(
            "No household was notified, because this visit is not linked to one.",
            said(false, "session_has_no_kinfolk"),
        )
        assertEquals("The notice to Dre East could not be sent.", said(false, "dispatch_failed"))
        assertEquals("Dre East was not notified.", said(false, "not_sent"))
        assertEquals("Dre East was not notified.", said(false, "something_newer"))
    }

    @Test
    fun `an undo or a no-op says nothing about the household`() {
        assertEquals("", said(false, "no_event_for_action"))
        assertEquals("", said(false, "already_in_this_state"))
    }

    @Test
    fun `the wait for the server's record says it is checking, and later that it still is`() {
        // #2037: Home and Auntie Time both show this while the record is on its way.
        assertEquals("Checking whether Dre East was told.", visitNoticeCheckingSentence("Dre East"))
        assertEquals("Checking who was told.", visitNoticeCheckingSentence(""))
        assertEquals("Still checking whether Dre East was told.", said(false, "notice_pending"))
    }

    @Test
    fun `a lower-case name opens the sentence with a capital`() {
        assertEquals("The Wrens was notified.", said(true, null, "the Wrens"))
    }

    @Test
    fun `no sentence uses an em dash`() {
        for (r in listOf("household_has_no_portal_account", "household_notices_off", "dispatch_failed", "not_sent")) {
            assertFalse(said(false, r).contains('—'))
        }
    }

    @Test
    fun `the dispatch result maps to an outcome, and an old server never gets a guessed cause`() {
        assertEquals(
            VisitNotifyOutcome(true, null),
            visitNotifyOutcomeOf(Result.success(VisitNotifier.DispatchResult(listOf("n1"), suppressed = false))),
        )
        assertEquals(
            VisitNotifyOutcome(false, "household_notices_off"),
            visitNotifyOutcomeOf(
                Result.success(VisitNotifier.DispatchResult(emptyList(), suppressed = true, reason = "household_notices_off")),
            ),
        )
        assertEquals(
            VisitNotifyOutcome(false, "not_sent"),
            visitNotifyOutcomeOf(Result.success(VisitNotifier.DispatchResult(emptyList(), suppressed = true))),
        )
        assertEquals(
            VisitNotifyOutcome(false, "dispatch_failed"),
            visitNotifyOutcomeOf(Result.failure(RuntimeException("INTERNAL"))),
        )
    }

    @Test
    fun `routing is decided from the row the way VisitNotifier decides it`() {
        assertNull(visitRoutingSkip(routed))
        assertNull(visitRoutingSkip(KinCareSession(id = "s", kinfolkId = "kf1", sourceBookingId = "legacy7")))
        assertEquals("session_has_no_routing_ids", visitRoutingSkip(KinCareSession(id = "s", kinfolkId = "kf1")))
        assertEquals("session_has_no_kinfolk", visitRoutingSkip(KinCareSession(id = "s")))
    }

    private val told = VisitNoticeReach.Ready(willNotify = true, reason = null)
    private fun not(reason: String?) = VisitNoticeReach.Ready(willNotify = false, reason = reason)

    private fun confirm(reach: VisitNoticeReach, event: VisitNotifier.Event = VisitNotifier.Event.ON_MY_WAY) =
        visitNoticeConfirmLine(event, routed, reach, "Dre East")

    @Test
    fun `the confirm promises a notice when the server says one can go out`() {
        assertEquals("Dre East will be told their Auntie is on the way.", confirm(told))
        assertEquals("Dre East will be told their Auntie has arrived.", confirm(told, VisitNotifier.Event.ARRIVED))
        assertEquals("Dre East will be told the visit has finished.", confirm(told, VisitNotifier.Event.DEPARTED))
    }

    @Test
    fun `a household with no portal sign-in will not be told, the Nov 10 case`() {
        assertEquals(
            "Dre East will not be told, because they have no portal account.",
            confirm(not("household_has_no_portal_account")),
        )
    }

    @Test
    fun `the switch is named when the server names it`() {
        assertEquals(
            "Dre East will not be told, because notices to households are off in Settings.",
            confirm(not("household_notices_off")),
        )
    }

    @Test
    fun `the confirm says it is checking while the server is asked, and promises nothing`() {
        assertEquals("Checking whether Dre East will be told.", confirm(VisitNoticeReach.Checking))
        assertEquals(
            "Checking who will be told.",
            visitNoticeConfirmLine(VisitNotifier.Event.ON_MY_WAY, routed, VisitNoticeReach.Checking, ""),
        )
    }

    @Test
    fun `the confirm says nothing about the household without a usable answer`() {
        assertNull(confirm(VisitNoticeReach.Unknown))
        assertNull(confirm(not("a_reason_from_a_newer_server")))
        assertNull(confirm(not(null)))
        assertNull(confirm(told, VisitNotifier.Event.REPORT_SENT))
    }

    @Test
    fun `the server answer becomes a reach, and a failed call is unknown`() {
        assertEquals(
            VisitNoticeReach.Ready(false, "household_has_no_portal_account"),
            visitNoticeReachOf(Result.success(VisitNotifier.PreviewResult(false, "household_has_no_portal_account"))),
        )
        assertEquals(VisitNoticeReach.Ready(true, null), visitNoticeReachOf(Result.success(VisitNotifier.PreviewResult(true))))
        assertEquals(VisitNoticeReach.Unknown, visitNoticeReachOf(Result.failure(RuntimeException("NOT_FOUND"))))
    }

    @Test
    fun `a row with nothing to route to is named before anything else`() {
        assertEquals(
            "Dre East will not be told, because this visit is not linked to a booking.",
            visitNoticeConfirmLine(VisitNotifier.Event.ARRIVED, KinCareSession(id = "s", kinfolkId = "kf1"), told, "Dre East"),
        )
        assertTrue(
            visitNoticeConfirmLine(VisitNotifier.Event.ARRIVED, KinCareSession(id = "s"), VisitNoticeReach.Checking, "Dre East")!!
                .startsWith("No household will be told"),
        )
    }
}
