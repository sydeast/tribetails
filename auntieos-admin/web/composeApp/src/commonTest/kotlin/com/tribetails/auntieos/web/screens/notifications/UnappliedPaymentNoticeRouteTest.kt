package com.tribetails.auntieos.web.screens.notifications

import com.tribetails.auntieos.web.data.NotificationEntry
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** #1003: the `invoice.payment.unapplied` notice opens the household, not the invoice. */
class UnappliedPaymentNoticeRouteTest {

    private val data = buildJsonObject {
        put("kinfolkId", "kf1")
        put("invoiceId", "inv1")
        put("stripeEventId", "evt_123")
        put("unappliedAmount", "$25.00")
    }

    @Test
    fun theUnappliedNoticeOpensTheHouseholdWithThatPayment() {
        val e = NotificationEntry(key = "invoice.payment.unapplied", targetType = "invoice", targetId = "inv1", data = data)
        assertEquals(NotificationOpenRoute.UnappliedPayment("kf1", "evt_123"), notificationOpenRoute(e))
        assertTrue(NotificationAction.OpenTarget in applicableActions(e))
    }

    @Test
    fun aNoticeWithNoPaymentIdStillOpensTheHousehold() {
        val e = NotificationEntry(
            key = "invoice.payment.unapplied",
            data = buildJsonObject { put("kinfolkId", "kf1") },
        )
        assertEquals(NotificationOpenRoute.UnappliedPayment("kf1", null), notificationOpenRoute(e))
        // No targetId, but the override still makes the row openable.
        assertTrue(NotificationAction.OpenTarget in applicableActions(e))
    }

    @Test
    fun withoutAKinfolkIdItFallsBackToTheTarget() {
        val e = NotificationEntry(
            key = "invoice.payment.unapplied",
            targetType = "invoice",
            targetId = "inv1",
            data = buildJsonObject { put("kinfolkId", "  "); put("stripeEventId", "evt_1") },
        )
        assertEquals(NotificationOpenRoute.Target("invoice", "inv1"), notificationOpenRoute(e))
        assertEquals(
            NotificationOpenRoute.Target("invoice", "inv1"),
            notificationOpenRoute(e.copy(data = null)),
        )
    }

    @Test
    fun everyOtherKeyKeepsItsTargetRoute() {
        for (key in listOf("invoice.paid", "invoice.new", "kincare.booking.confirm", "")) {
            val e = NotificationEntry(key = key, targetType = "invoice", targetId = "inv1", data = data)
            assertEquals(NotificationOpenRoute.Target("invoice", "inv1"), notificationOpenRoute(e), key)
        }
    }

    @Test
    fun theNoticeDataDecodesFromTheStoredDocument() {
        val codec = Json { ignoreUnknownKeys = true; isLenient = true }
        val e = codec.decodeFromString(
            NotificationEntry.serializer(),
            """{"_id":"n1","key":"invoice.payment.unapplied","targetType":"invoice","targetId":"inv1",
               "data":{"kinfolkId":"kf1","invoiceId":"inv1","stripeEventId":"evt_9","amount":2500}}""",
        )
        assertEquals(NotificationOpenRoute.UnappliedPayment("kf1", "evt_9"), notificationOpenRoute(e))
    }

    @Test
    fun anOddDataFieldDoesNotDropTheNotification() {
        val codec = Json { ignoreUnknownKeys = true; isLenient = true }
        val e = codec.decodeFromString(NotificationEntry.serializer(), """{"_id":"n2","key":"x","data":"text"}""")
        assertEquals("n2", e._id)
        assertNull(e.data)
    }
}
