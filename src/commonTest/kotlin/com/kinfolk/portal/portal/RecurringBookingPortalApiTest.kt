package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Stage 3 / 16.3 - requestBookingMultiVisit serializes a weekly series correctly. */
class RecurringBookingPortalApiTest {

    @Test
    fun weeklySeries_sendsPatternWeekly_weeklyDays_andVisits() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("requestBooking", buildJsonObject { put("batchId", "req_1") })
        val visits = listOf(
            BookingVisit(startTimeMs = 1_900_000_000_000, endTimeMs = null, serviceId = "s1", serviceName = "Walk", priceCents = 1000),
            BookingVisit(startTimeMs = 1_900_086_400_000, endTimeMs = null, serviceId = "s1", serviceName = "Walk", priceCents = 1000),
        )
        val batchId = PortalApi(fake).requestBookingMultiVisit(
            kinfolkId = "kf1",
            kinIds = listOf("k1"),
            pattern = BookingPattern.Weekly,
            weeklyDays = listOf(1, 3),
            visits = visits,
        )
        assertEquals("req_1", batchId)
        val payload = fake.calls.single().second!!
        assertEquals("weekly", payload["pattern"]!!.jsonPrimitive.content)
        assertEquals(listOf(1, 3), (payload["weeklyDays"] as JsonArray).map { it.jsonPrimitive.content.toInt() })
        assertEquals(2, payload["visits"]!!.jsonArray.size)
    }

    @Test
    fun individualSeries_omitsWeeklyDays() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("requestBooking", buildJsonObject { put("batchId", "req_2") })
        PortalApi(fake).requestBookingMultiVisit(
            kinfolkId = "kf1",
            pattern = BookingPattern.Individual,
            weeklyDays = null,
            visits = listOf(BookingVisit(1_900_000_000_000, null, "s1", "Walk", 1000)),
        )
        val payload = fake.calls.single().second!!
        assertEquals("individual", payload["pattern"]!!.jsonPrimitive.content)
        assertTrue(!payload.containsKey("weeklyDays"))
    }
}
