package com.tribetails.auntieos.web.screens.schedule

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #1576: the Schedule's visit sheet offers what Bookings offers. Mirrors the
 * web's `actionsFor` (`BookingActions.tsx`), with the in-field states the
 * server completes or cancels from.
 */
class ScheduleSheetActionsTest {
    @Test
    fun aVisitOnTheBooksOffersMarkCompletedThenCancel() {
        for (status in listOf("SCHEDULED", "scheduled", "ON_MY_WAY", "ARRIVED", "DEPARTED")) {
            assertEquals(listOf(ScheduleSheetAction.MarkCompleted, ScheduleSheetAction.Cancel), scheduleSheetActions(status), status)
        }
    }

    @Test
    fun aRequestOffersApproveThenReject() {
        for (status in listOf("PENDING", "DRAFT")) {
            assertEquals(listOf(ScheduleSheetAction.Approve, ScheduleSheetAction.Reject), scheduleSheetActions(status), status)
        }
    }

    @Test
    fun aClosedOrUnknownStatusOffersNothing() {
        for (status in listOf("COMPLETED", "CANCELLED", "", "WHATEVER")) {
            assertTrue(scheduleSheetActions(status).isEmpty(), status)
        }
    }

    @Test
    fun theWordsAreTheWebsWords() {
        assertEquals("Mark Completed", ScheduleSheetAction.MarkCompleted.label)
        assertEquals("The Wrens's visit is marked Completed.", scheduleSheetActionToast(ScheduleSheetAction.MarkCompleted, "The Wrens"))
        assertEquals("The Wrens's visit is cancelled.", scheduleSheetActionToast(ScheduleSheetAction.Cancel, "The Wrens"))
        assertEquals(
            "The Wrens's visit will be cancelled. This cannot be undone.",
            scheduleSheetConfirmBody(ScheduleSheetAction.Cancel, "The Wrens"),
        )
        assertEquals("Yes, cancel the visit", scheduleSheetConfirmLabel(ScheduleSheetAction.Cancel))
    }
}
