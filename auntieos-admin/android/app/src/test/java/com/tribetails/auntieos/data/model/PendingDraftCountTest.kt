package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * #1629: Home's "KinTales to review" counted `status == "pending"` server-side,
 * so a draft generate.js wrote (`generated`, snake_case copy) was never
 * counted, while the rows beside it read both spellings. The count now uses the
 * rows' rule.
 */
class PendingDraftCountTest {

    @Test
    fun `a generate js draft counts, read from its own spellings`() {
        val generated = draftFromFields(
            "g1",
            mapOf(
                "status" to "generated",
                "generated_copy" to "QA- test note",
                "kinfolk_id" to "k2",
                "generated_at" to "2026-11-05T18:30:00.000Z",
            ),
        )
        assertEquals(1, pendingDraftCountOf(listOf(generated)))
    }

    @Test
    fun `sent, approved and content-less drafts do not count`() {
        val drafts = listOf(
            Draft(id = "p", status = "pending", generatedCopy = "Biscuit ran"),
            Draft(id = "blank", status = "", generatedCopy = "Mochi napped"),
            Draft(id = "sent", status = "published", generatedCopy = "x", publishedReportId = "r1"),
            Draft(id = "approved", status = "approved", generatedCopy = "x"),
            Draft(id = "shell", status = "pending", generatedCopy = "   "),
        )
        assertEquals(2, pendingDraftCountOf(drafts))
    }
}
