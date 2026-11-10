package com.tribetails.auntieos.web.screens.sessions

import com.tribetails.auntieos.web.data.KinCareSession
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1799: a DEPARTED Auntie Time card whose KinTale has been sent offers
 * Complete and View KinTale, as Android's Home card and admin web's card do;
 * any other DEPARTED card keeps Complete KinTale. Complete takes the kebab's
 * Mark Completed path: the #1608 pre-check, then transitionBookingStatus.
 */
class DepartedCardActionsTest {

    private fun departed(eligible: Boolean, arrivedAt: String = "2026-11-10T16:00:00Z", departedAt: String = "2026-11-10T17:00:00Z") =
        KinCareSession(_id = "s1", status = "DEPARTED", autoCompleteEligible = eligible, arrivedAt = arrivedAt, departedAt = departedAt)

    @Test
    fun aSentDepartedCardOffersCompleteAndViewKinTale() {
        assertEquals(DepartedCardActions.CompleteAndView, departedCardActions(departed(eligible = true)))
    }

    @Test
    fun anUnsentDepartedCardKeepsCompleteKinTale() {
        assertEquals(DepartedCardActions.WriteKinTale, departedCardActions(departed(eligible = false)))
    }

    @Test
    fun theFlagAloneDoesNotOfferCompleteOutsideDeparted() {
        // Only DEPARTED reaches this branch on the card, but the rule itself
        // must not say yes for an ARRIVED visit with a sent tale.
        assertEquals(
            DepartedCardActions.WriteKinTale,
            departedCardActions(KinCareSession(_id = "s1", status = "ARRIVED", autoCompleteEligible = true)),
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
            now = "2026-11-10T18:00:00Z",
        )
        return c
    }

    @Test
    fun completeGoesThroughTransitionBookingStatusNeverAPatch() {
        val c = complete(departed(eligible = true), arrivalRule = true)
        assertNull(c.refused)
        assertEquals("s1", c.id)
        assertEquals(KinCareWrite.Transition("COMPLETE", completedAt = "2026-11-10T18:00:00Z"), c.write)
        assertEquals("Marked Completed.", c.message)
    }

    @Test
    fun completeIsRefusedLocallyWhenTheArrivalRuleIsCertainToRefuseIt() {
        val c = complete(departed(eligible = true, arrivedAt = ""), arrivalRule = true)
        assertNull(c.write)
        assertTrue(c.refused!!.startsWith("This visit has no arrival recorded"))
    }

    @Test
    fun anUnknownArrivalRuleLeavesTheDecisionToTheServer() {
        val c = complete(departed(eligible = true, arrivedAt = "", departedAt = ""), arrivalRule = null)
        assertNull(c.refused)
        assertEquals(KinCareWrite.Transition("COMPLETE", completedAt = "2026-11-10T18:00:00Z"), c.write)
    }
}
