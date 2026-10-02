package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.repository.BatchBookingFailure
import com.tribetails.auntieos.data.repository.BatchBookingResult
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Stage 2 tail: the fail-loud summary for a batch booking transition. A partial
 * result must always name the failures; a clean result reads as a simple count.
 */
class BatchBookingSummaryTest {

    private fun result(action: String, updated: Int, failed: Int) = BatchBookingResult(
        action = action,
        updated = updated,
        failed = (1..failed).map { BatchBookingFailure(id = "v$it", error = "write-failed") },
    )

    @Test fun `clean approve reads as a plain count`() {
        assertEquals("Approved 3.", batchBookingSummary(result("APPROVE", 3, 0)))
    }

    @Test fun `partial reject names the failures`() {
        assertEquals("Rejected 2, 1 failed. The change could not be saved.", batchBookingSummary(result("REJECT", 2, 1)))
    }

    @Test fun `cancel maps to past tense`() {
        assertEquals("Cancelled 0, 2 failed. The change could not be saved.", batchBookingSummary(result("CANCEL", 0, 2)))
    }

    @Test fun `unknown action is echoed verbatim`() {
        assertEquals("WHAT 1.", batchBookingSummary(result("WHAT", 1, 0)))
    }

    // #1099: approving now books the visit, so a refusal carries a reason to read.
    @Test fun `approve failure shows the server's own words`() {
        val r = BatchBookingResult(
            "APPROVE", 1,
            listOf(BatchBookingFailure("v1", "That time overlaps a busy block on your Google Calendar.")),
        )
        assertEquals(
            "Approved 1, 1 failed. That time overlaps a busy block on your Google Calendar.",
            batchBookingSummary(r),
        )
    }
    @Test fun `the same reason on several ids is said once`() {
        val r = BatchBookingResult(
            "APPROVE", 0,
            listOf(BatchBookingFailure("v1", "Closed that day."), BatchBookingFailure("v2", "Closed that day.")),
        )
        assertEquals("Approved 0, 2 failed. Closed that day.", batchBookingSummary(r))
    }
    @Test fun `not-found becomes a sentence`() {
        val r = BatchBookingResult("APPROVE", 0, listOf(BatchBookingFailure("v1", "not-found")))
        assertEquals("Approved 0, 1 failed. That booking was not found.", batchBookingSummary(r))
    }
}
