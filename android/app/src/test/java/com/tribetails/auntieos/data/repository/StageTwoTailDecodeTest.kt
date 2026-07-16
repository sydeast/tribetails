package com.tribetails.auntieos.data.repository

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Stage 2 tail: pure decoders for the new callable payloads (sendInvoiceReminder,
 * batchUpdateBookings, bulkMarkNotificationsRead). These are the decode contracts the
 * AuntieRepository callable methods delegate to, kept pure so they are exhaustively
 * testable without Firebase static init.
 */
class StageTwoTailDecodeTest {

    // ── sendInvoiceReminder ──────────────────────────────────────────────────────

    @Test fun `reminder decode echoes server invoiceId`() {
        assertEquals("inv-9", decodeSentReminderInvoiceId(mapOf("ok" to true, "invoiceId" to "inv-9"), "inv-1"))
    }

    @Test fun `reminder decode falls back to requested id when missing`() {
        assertEquals("inv-1", decodeSentReminderInvoiceId(mapOf("ok" to true), "inv-1"))
        assertEquals("inv-1", decodeSentReminderInvoiceId(null, "inv-1"))
    }

    @Test fun `reminder decode falls back when server id is blank`() {
        assertEquals("inv-1", decodeSentReminderInvoiceId(mapOf("invoiceId" to ""), "inv-1"))
    }

    // ── bulkMarkNotificationsRead ────────────────────────────────────────────────

    @Test fun `marked count decodes from number`() {
        assertEquals(3, decodeMarkedCount(mapOf("marked" to 3)))
        assertEquals(3, decodeMarkedCount(mapOf("marked" to 3.0)))
    }

    @Test fun `marked count defaults to zero when missing`() {
        assertEquals(0, decodeMarkedCount(mapOf("ok" to true)))
        assertEquals(0, decodeMarkedCount(null))
    }

    // ── archiveNotification / bulkArchiveNotifications (Step 4) ───────────────────

    @Test fun `archived count decodes from number`() {
        assertEquals(1, decodeArchivedCount(mapOf("archived" to 1)))
        assertEquals(3, decodeArchivedCount(mapOf("archived" to 3.0)))
    }

    @Test fun `archived count defaults to zero when missing`() {
        assertEquals(0, decodeArchivedCount(mapOf("ok" to true)))
        assertEquals(0, decodeArchivedCount(null))
    }

    // ── batchUpdateBookings ──────────────────────────────────────────────────────

    @Test fun `batch decode reads action updated and failures`() {
        val raw = mapOf(
            "ok" to true,
            "action" to "APPROVE",
            "updated" to 2,
            "failed" to listOf(
                mapOf("id" to "v3", "error" to "not_found"),
                mapOf("id" to "v4", "error" to "already_cancelled"),
            ),
        )
        val r = decodeBatchBookingResult(raw, "REJECT")
        assertEquals("APPROVE", r.action)
        assertEquals(2, r.updated)
        assertEquals(2, r.failedCount)
        assertEquals("v3", r.failed[0].id)
        assertEquals("not_found", r.failed[0].error)
    }

    @Test fun `batch decode tolerates missing payload and falls back to requested action`() {
        val r = decodeBatchBookingResult(null, "CANCEL")
        assertEquals("CANCEL", r.action)
        assertEquals(0, r.updated)
        assertEquals(0, r.failedCount)
    }

    @Test fun `batch decode skips malformed failure entries`() {
        val raw = mapOf(
            "action" to "REJECT",
            "updated" to 1,
            "failed" to listOf(
                mapOf("id" to "v1", "error" to "x"),
                mapOf("error" to "no-id-here"), // dropped (no id)
                "not-a-map",                    // dropped
            ),
        )
        val r = decodeBatchBookingResult(raw, "REJECT")
        assertEquals(1, r.failedCount)
        assertEquals("v1", r.failed[0].id)
    }
}
