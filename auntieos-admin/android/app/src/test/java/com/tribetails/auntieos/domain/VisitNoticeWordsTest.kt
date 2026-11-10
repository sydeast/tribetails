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

    private fun confirm(hasAccount: Boolean?, live: Boolean?, event: VisitNotifier.Event = VisitNotifier.Event.ON_MY_WAY) =
        visitNoticeConfirmLine(event, routed, hasAccount, live, "Dre East")

    @Test
    fun `the confirm promises a notice only with an account and the switch on`() {
        assertEquals("Dre East will be told their Auntie is on the way.", confirm(true, true))
        assertEquals(
            "Dre East will be told their Auntie has arrived.",
            confirm(true, true, VisitNotifier.Event.ARRIVED),
        )
        assertEquals(
            "Dre East will be told the visit has finished.",
            confirm(true, true, VisitNotifier.Event.DEPARTED),
        )
    }

    @Test
    fun `no portal account is named before the switch, the Nov 10 case`() {
        assertEquals("Dre East will not be told, because they have no portal account.", confirm(false, false))
    }

    @Test
    fun `the switch is named for a household that has an account`() {
        assertEquals(
            "Dre East will not be told, because notices to households are off in Settings.",
            confirm(true, false),
        )
    }

    @Test
    fun `the confirm says nothing about the household while either input loads`() {
        assertNull(confirm(null, true))
        assertNull(confirm(true, null))
        assertNull(confirm(null, false))
    }

    @Test
    fun `a row with nothing to route to is named before anything else`() {
        assertEquals(
            "Dre East will not be told, because this visit is not linked to a booking.",
            visitNoticeConfirmLine(VisitNotifier.Event.ARRIVED, KinCareSession(id = "s", kinfolkId = "kf1"), true, true, "Dre East"),
        )
        assertTrue(
            visitNoticeConfirmLine(VisitNotifier.Event.ARRIVED, KinCareSession(id = "s"), true, true, "Dre East")!!
                .startsWith("No household will be told"),
        )
    }
}
