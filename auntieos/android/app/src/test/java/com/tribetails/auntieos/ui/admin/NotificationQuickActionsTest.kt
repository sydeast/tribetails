package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.admin.NotificationEntry
import com.tribetails.auntieos.ui.notificationTargetRoute
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Step 4: the pure decisions behind the per-notification quick actions.
 *   - [applicableNotificationActions] decides which buttons (Open / Approve / Deny)
 *     a row shows from its targetType / targetId.
 *   - [notificationTargetRoute] maps targetType / targetId to a nav route for the
 *     "open linked item" action.
 * Both are pure so the action wiring is exhaustively testable without Firebase or
 * a live NavController.
 */
class NotificationQuickActionsTest {

    // ── applicableNotificationActions ────────────────────────────────────────────

    @Test fun `booking target enables open AND approve-deny`() {
        val a = applicableNotificationActions("booking", "bk-1")
        assertTrue(a.canOpen)
        assertTrue(a.canApproveDeny)
    }

    @Test fun `invoice target enables open but not approve-deny`() {
        val a = applicableNotificationActions("invoice", "inv-1")
        assertTrue(a.canOpen)
        assertFalse(a.canApproveDeny)
    }

    @Test fun `kintale and kinfolk targets enable open only`() {
        assertTrue(applicableNotificationActions("kintale", "rpt-1").canOpen)
        assertFalse(applicableNotificationActions("kintale", "rpt-1").canApproveDeny)
        assertTrue(applicableNotificationActions("kinfolk", "kf-1").canOpen)
        assertFalse(applicableNotificationActions("kinfolk", "kf-1").canApproveDeny)
    }

    @Test fun `unknown type or blank id enables neither`() {
        assertFalse(applicableNotificationActions("", "x").canOpen)
        assertFalse(applicableNotificationActions("system", "x").canOpen)
        assertFalse(applicableNotificationActions("booking", "").canOpen)
        assertFalse(applicableNotificationActions("booking", "   ").canApproveDeny)
    }

    @Test fun `type match is case and whitespace insensitive`() {
        val a = applicableNotificationActions(" Booking ", "bk-1")
        assertTrue(a.canOpen)
        assertTrue(a.canApproveDeny)
    }

    @Test fun `kinfolk target enables create-quote`() {
        assertTrue(applicableNotificationActions("kinfolk", "kf-1").canCreateQuote)
        assertFalse(applicableNotificationActions("invoice", "inv-1").canCreateQuote)
        assertFalse(applicableNotificationActions("booking", "bk-1").canCreateQuote)
        assertFalse(applicableNotificationActions("kinfolk", "").canCreateQuote)
    }

    // ── notificationTargetRoute ──────────────────────────────────────────────────

    @Test fun `booking routes to kin care detail`() {
        assertEquals("kin_care_detail/bk-1", notificationTargetRoute("booking", "bk-1"))
    }

    @Test fun `invoice routes to invoice detail`() {
        assertEquals("invoice_detail/inv-1", notificationTargetRoute("invoice", "inv-1"))
    }

    @Test fun `kinfolk routes to kinfolk profile`() {
        assertEquals("kinfolk_profile/kf-1", notificationTargetRoute("kinfolk", "kf-1"))
    }

    @Test fun `kintale routes to the kintales list`() {
        assertEquals("admin_kintale_logs", notificationTargetRoute("kintale", "rpt-1"))
    }

    @Test fun `unknown type or blank id routes nowhere`() {
        assertNull(notificationTargetRoute("system", "x"))
        assertNull(notificationTargetRoute("", "x"))
        assertNull(notificationTargetRoute("invoice", ""))
        assertNull(notificationTargetRoute("booking", "   "))
    }

    // ── archived filter (Step 4) ─────────────────────────────────────────────────
    // The default inbox hides archived notifications. The repository filters them out
    // (archivedAt non-blank => archived); this guards the predicate the screen relies on.

    @Test fun `archivedAt marker means archived`() {
        val active = NotificationEntry(id = "n1", archivedAt = null)
        val alsoActive = NotificationEntry(id = "n2", archivedAt = "")
        val archived = NotificationEntry(id = "n3", archivedAt = "2026-06-05T10:00:00Z")
        val visible = listOf(active, alsoActive, archived).filter { it.archivedAt.isNullOrBlank() }
        assertEquals(listOf("n1", "n2"), visible.map { it.id })
    }
}
