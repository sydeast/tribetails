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
        failed = (1..failed).map { BatchBookingFailure(id = "v$it", error = "e") },
    )

    @Test fun `clean approve reads as a plain count`() {
        assertEquals("Approved 3.", batchBookingSummary(result("APPROVE", 3, 0)))
    }

    @Test fun `partial reject names the failures`() {
        assertEquals("Rejected 2, 1 failed.", batchBookingSummary(result("REJECT", 2, 1)))
    }

    @Test fun `cancel maps to past tense`() {
        assertEquals("Cancelled 0, 2 failed.", batchBookingSummary(result("CANCEL", 0, 2)))
    }

    @Test fun `unknown action is echoed verbatim`() {
        assertEquals("WHAT 1.", batchBookingSummary(result("WHAT", 1, 0)))
    }
}
