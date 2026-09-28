package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.admin.NotificationEntry
import com.tribetails.auntieos.ui.Screen
import com.tribetails.auntieos.ui.notificationOpenRoute
import com.tribetails.auntieos.ui.notificationTargetRoute
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1003: the `invoice.payment.unapplied` notice targets the invoice on the
 * server, but Open takes the operator to the HOUSEHOLD profile, where the
 * payment's Decide dialog opens. Every other key keeps its target routing.
 */
class NotificationUnappliedPaymentRouteTest {

    private fun unapplied(data: Map<String, Any?> = mapOf("kinfolkId" to "fam1", "invoiceId" to "inv42", "stripeEventId" to "evt_1")) =
        NotificationEntry(id = "n1", key = "invoice.payment.unapplied", targetType = "invoice", targetId = "inv42", data = data)

    @Test
    fun `the unapplied notice points at the household and the payment`() {
        assertEquals(UnappliedPaymentNotice("fam1", "evt_1"), unappliedPaymentNotice(unapplied()))
        assertEquals(Screen.KinfolkProfile.createRoute("fam1"), notificationOpenRoute(unapplied()))
    }

    @Test
    fun `the household is found under familyId too, and a missing event id still opens the list`() {
        val e = unapplied(mapOf("familyId" to "fam2"))
        assertEquals(UnappliedPaymentNotice("fam2", ""), unappliedPaymentNotice(e))
        assertEquals(Screen.KinfolkProfile.createRoute("fam2"), notificationOpenRoute(e))
    }

    @Test
    fun `with no household it falls back to the invoice target`() {
        val e = unapplied(mapOf("invoiceId" to "inv42"))
        assertNull(unappliedPaymentNotice(e))
        assertEquals(notificationTargetRoute("invoice", "inv42"), notificationOpenRoute(e))
    }

    @Test
    fun `Open is offered even when the invoice target is blank`() {
        val e = unapplied().copy(targetId = "")
        assertTrue(applicableNotificationActions(e).canOpen)
    }

    @Test
    fun `other keys keep their target routing`() {
        val paid = NotificationEntry(
            id = "n2", key = "invoice.paid", targetType = "invoice", targetId = "inv42",
            data = mapOf("kinfolkId" to "fam1", "stripeEventId" to "evt_1"),
        )
        assertNull(unappliedPaymentNotice(paid))
        assertEquals(notificationTargetRoute("invoice", "inv42"), notificationOpenRoute(paid))
        val kin = NotificationEntry(id = "n3", key = "kinfolk.updated", targetType = "kinfolk", targetId = "fam9")
        assertEquals(Screen.KinfolkProfile.createRoute("fam9"), notificationOpenRoute(kin))
    }
}
