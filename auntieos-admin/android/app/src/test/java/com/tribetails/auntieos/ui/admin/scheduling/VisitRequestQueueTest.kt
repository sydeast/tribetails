package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.contracts.CancelRequestDto
import com.tribetails.auntieos.data.contracts.RescheduleRequestDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * #438 (+ #399 item 2): the two asks a household can leave on a visit, merged
 * into one queue. Pure; the screen and the view model are shells around this.
 */
class VisitRequestQueueTest {

    private fun cancel(
        visitId: String = "v1",
        kinfolkId: String = "fam-1",
        requestedAtMs: Long? = 100L,
        title: String? = "Evening sit",
    ) = CancelRequestDto(
        kinfolkId = kinfolkId,
        batchId = "b1",
        visitId = visitId,
        title = title,
        serviceType = "Pet Sitting",
        kinNames = listOf("Nutmeg"),
        status = "confirmed",
        startTimeMs = 1_700_000_000_000L,
        endTimeMs = null,
        reason = "We are taking her with us",
        requestedAtMs = requestedAtMs,
    )

    private fun reschedule(
        visitId: String = "v2",
        kinfolkId: String = "fam-2",
        requestedAtMs: Long? = 200L,
        title: String? = "Morning drop-in",
    ) = RescheduleRequestDto(
        kinfolkId = kinfolkId,
        batchId = "b2",
        visitId = visitId,
        title = title,
        serviceType = "Drop-in Visit",
        kinNames = listOf("Biscuit"),
        status = "confirmed",
        currentStartTimeMs = 1_700_000_000_000L,
        currentEndTimeMs = null,
        proposedStartTimeMs = 1_700_100_000_000L,
        proposedEndTimeMs = null,
        reason = "Flight moved",
        requestedAtMs = requestedAtMs,
    )

    @Test
    fun mergesBothQueuesOldestFirst() {
        val rows = mergeVisitRequests(
            listOf(reschedule(requestedAtMs = 300L)),
            listOf(cancel(requestedAtMs = 100L), cancel(visitId = "v9", requestedAtMs = 200L)),
        )
        assertEquals(listOf(100L, 200L, 300L), rows.map { it.requestedAtMs })
    }

    @Test
    fun aRowWithNoTimestampSortsLastRatherThanPretendingItWaitedSince1970() {
        val rows = mergeVisitRequests(
            listOf(reschedule(requestedAtMs = null)),
            listOf(cancel(requestedAtMs = 100L)),
        )
        assertEquals(listOf("Cancel", "Reschedule"), rows.map { it.kindLabel() })
    }

    @Test
    fun keySeparatesTheTwoAsksOneVisitCanCarryAtOnce() {
        // A household that proposed a new time and then decided to cancel
        // outright has both rows on the same visit path. Keying on the path
        // alone would collapse them and resolve the wrong one.
        val sameVisit = mergeVisitRequests(
            listOf(reschedule(visitId = "v1", kinfolkId = "fam-1")),
            listOf(cancel(visitId = "v1", kinfolkId = "fam-1")),
        )
        assertEquals(2, sameVisit.size)
        assertNotEquals(sameVisit[0].key, sameVisit[1].key)
    }

    @Test
    fun keyIsUniqueAcrossHouseholds() {
        // A visit id is only unique inside its household.
        val a = VisitRequestRow.Cancel(cancel(kinfolkId = "fam-1")).key
        val b = VisitRequestRow.Cancel(cancel(kinfolkId = "fam-2")).key
        assertNotEquals(a, b)
    }

    @Test
    fun titleFallsBackToServiceThenToAPlainWord() {
        assertEquals("Evening sit", VisitRequestRow.Cancel(cancel()).title)
        assertEquals("Pet Sitting", VisitRequestRow.Cancel(cancel(title = null)).title)
        assertEquals(
            "Visit",
            VisitRequestRow.Cancel(cancel(title = null).copy(serviceType = null)).title,
        )
    }

    @Test
    fun acceptLabelSaysWhatTheDecisionActuallyDoes() {
        // Never a bare "Accept": accepting a cancellation and accepting a
        // reschedule do opposite things to the schedule.
        assertEquals("Cancel the visit", VisitRequestRow.Cancel(cancel()).acceptLabel())
        assertEquals("Move the visit", VisitRequestRow.Reschedule(reschedule()).acceptLabel())
    }

    @Test
    fun declineNoteLabelIsTheSameOptionalPromptForEveryKind() {
        // #700: the office does not owe the household a reason, so the field is
        // one shared "optional extra" prompt rather than a per-kind question.
        assertEquals(
            "Anything to add for the household (optional)",
            VisitRequestRow.Cancel(cancel()).declineNoteLabel(),
        )
        assertEquals(
            "Anything to add for the household (optional)",
            VisitRequestRow.Reschedule(reschedule()).declineNoteLabel(),
        )
    }

    @Test
    fun bothQueuesEmptyIsAnEmptyList() {
        assertEquals(emptyList<VisitRequestRow>(), mergeVisitRequests(emptyList(), emptyList()))
    }
}
