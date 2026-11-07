package com.tribetails.auntieos.web.screens.booking

import com.tribetails.auntieos.web.data.BookingNote
import com.tribetails.auntieos.web.data.StaffMember
import com.tribetails.auntieos.web.screens.schedule.bookingNoteAuthorLabel
import kotlin.test.Test
import kotlin.test.assertEquals

/** #1607: the bulk bar fits the selection, and a staff note names its writer. */
class BookingsWalk1607Test {
    @Test
    fun scheduledVisitsAreOfferedCancelOnly() {
        assertEquals(listOf("CANCEL"), bulkActionsForStatuses(listOf("SCHEDULED", "scheduled")))
        assertEquals(listOf("CANCEL"), bulkActionsForStatuses(listOf("DEPARTED")))
    }

    @Test
    fun requestsAreOfferedApproveAndReject() {
        assertEquals(listOf("APPROVE", "REJECT"), bulkActionsForStatuses(listOf("PENDING")))
        assertEquals(listOf("APPROVE", "REJECT", "CANCEL"), bulkActionsForStatuses(listOf("DRAFT", "SCHEDULED")))
    }

    @Test
    fun finishedVisitsAreOfferedNothing() {
        assertEquals(emptyList(), bulkActionsForStatuses(listOf("COMPLETED", "CANCELLED")))
    }

    @Test
    fun aStaffNoteIsNamedByItsWriterNotCalledAuntie() {
        val roster = listOf(StaffMember(uid = "u-owner", displayName = "The office"))
        assertEquals("The office", bookingNoteAuthorLabel(BookingNote(authorUid = "u-owner", authorRole = "admin"), roster))
        assertEquals("Staff", bookingNoteAuthorLabel(BookingNote(authorUid = "u-gone", authorRole = "admin"), roster))
        assertEquals("Staff", bookingNoteAuthorLabel(BookingNote(authorUid = "u-owner", authorRole = "admin"), null))
        assertEquals("Kinfolk", bookingNoteAuthorLabel(BookingNote(authorRole = "kinfolk"), roster))
    }
}
