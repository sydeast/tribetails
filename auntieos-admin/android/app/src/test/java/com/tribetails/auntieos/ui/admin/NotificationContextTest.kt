package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.admin.NotificationEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Operator issue #20: the notifications feed read like a second Activity Log,
 * because the row printed a catalog key and nothing about WHO it concerned.
 *
 * The household is not a column on the notification doc. `dispatcher.ts` writes
 * a free-form `data` bag (which usually holds only ids) and a `targetType` /
 * `targetId` pair, so the household has to be derived, and the display name
 * resolved against the kinfolk directory. These are the pure decisions behind
 * that, mirroring the web build's `lib/notificationContext.ts` exactly so the
 * two clients cannot disagree about which household a notification is about.
 */
class NotificationContextTest {

    // ── notificationKinfolkId ────────────────────────────────────────────────

    @Test fun `reads data kinfolkId, the id emitters actually enqueue`() {
        val entry = NotificationEntry(id = "n1", data = mapOf("kinfolkId" to "kf-1"))
        assertEquals("kf-1", notificationKinfolkId(entry))
    }

    @Test fun `falls back to data familyId, the dispatcher resolveTargetRef alias`() {
        val entry = NotificationEntry(id = "n1", data = mapOf("familyId" to "kf-2"))
        assertEquals("kf-2", notificationKinfolkId(entry))
    }

    @Test fun `falls back to targetId only for a kinfolk-typed target`() {
        val household = NotificationEntry(id = "n1", targetType = "kinfolk", targetId = "kf-3")
        assertEquals("kf-3", notificationKinfolkId(household))
        val invoice = NotificationEntry(id = "n2", targetType = "invoice", targetId = "inv-1")
        assertEquals("", notificationKinfolkId(invoice))
    }

    @Test fun `survives a doc with no data map and a non-string value`() {
        assertEquals("", notificationKinfolkId(NotificationEntry(id = "n1")))
        assertEquals("", notificationKinfolkId(NotificationEntry(id = "n2", data = mapOf("kinfolkId" to 42))))
    }

    // ── notificationKinfolkName ──────────────────────────────────────────────

    private val names = mapOf("kf-1" to "Dana Ruiz")

    @Test fun `prefers a name the emitter already put on the doc`() {
        val entry = NotificationEntry(id = "n1", data = mapOf("kinfolkName" to "The Ruiz Household"))
        assertEquals("The Ruiz Household", notificationKinfolkName(entry, names))
    }

    @Test fun `resolves the id against the directory when the doc has only an id`() {
        val entry = NotificationEntry(id = "n1", data = mapOf("kinfolkId" to "kf-1"))
        assertEquals("Dana Ruiz", notificationKinfolkName(entry, names))
    }

    @Test fun `returns blank rather than inventing a name for an unresolvable id`() {
        val entry = NotificationEntry(id = "n1", data = mapOf("kinfolkId" to "gone"))
        assertEquals("", notificationKinfolkName(entry, names))
    }

    // ── notificationTargetLabel ──────────────────────────────────────────────

    @Test fun `names the linked entity in operator language`() {
        assertEquals("Invoice", notificationTargetLabel(NotificationEntry(id = "n", targetType = "invoice", targetId = "i")))
        assertEquals("KinTale", notificationTargetLabel(NotificationEntry(id = "n", targetType = "kintale", targetId = "t")))
        assertEquals("Household", notificationTargetLabel(NotificationEntry(id = "n", targetType = "kinfolk", targetId = "k")))
        assertEquals("Booking", notificationTargetLabel(NotificationEntry(id = "n", targetType = "booking", targetId = "b")))
    }

    @Test fun `is blank for an unknown or missing target so no chip renders`() {
        assertEquals("", notificationTargetLabel(NotificationEntry(id = "n", targetType = "payout", targetId = "p")))
        assertEquals("", notificationTargetLabel(NotificationEntry(id = "n", targetType = "invoice", targetId = "")))
        assertEquals("", notificationTargetLabel(NotificationEntry(id = "n")))
    }

    // ── notificationHeadline ─────────────────────────────────────────────────

    @Test fun `prefers the catalog title over the raw key`() {
        val entry = NotificationEntry(id = "n1", key = "kincare.booking.confirm", title = "Visit confirmed")
        assertEquals("Visit confirmed", notificationHeadline(entry))
    }

    @Test fun `falls back to the key for rows dispatched before titles existed`() {
        val entry = NotificationEntry(id = "n1", key = "kincare.booking.confirm")
        assertEquals("kincare.booking.confirm", notificationHeadline(entry))
    }

    @Test fun `falls back to a marker when there is no key either`() {
        assertEquals("(no key)", notificationHeadline(NotificationEntry(id = "n1")))
    }

    // ── create-quote widening ────────────────────────────────────────────────

    @Test fun `create-quote follows the derived household, not just a kinfolk target`() {
        // An invoice notification that names its household can still be quoted.
        val invoice = NotificationEntry(
            id = "n1",
            targetType = "invoice",
            targetId = "inv-1",
            data = mapOf("kinfolkId" to "kf-9"),
        )
        assertTrue(applicableNotificationActions(invoice).canCreateQuote)
        assertEquals("kf-9", notificationKinfolkId(invoice))
    }

    @Test fun `create-quote disappears when no household can be identified`() {
        val tale = NotificationEntry(id = "n1", targetType = "kintale", targetId = "t-1")
        assertFalse(applicableNotificationActions(tale).canCreateQuote)
    }

    @Test fun `the entry overload keeps the open and approve-deny rules unchanged`() {
        val booking = NotificationEntry(id = "n1", targetType = "booking", targetId = "bk-1")
        val actions = applicableNotificationActions(booking)
        assertTrue(actions.canOpen)
        assertTrue(actions.canApproveDeny)

        val unknown = NotificationEntry(id = "n2", targetType = "payout", targetId = "p-1")
        assertFalse(applicableNotificationActions(unknown).canOpen)
        assertFalse(applicableNotificationActions(unknown).canApproveDeny)
    }
}
