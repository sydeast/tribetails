package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull

class BookingWizardTest {

    @Test
    fun `getServiceCatalog decodes flat services with single price`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getServiceCatalog", buildJsonObject {
            put("services", buildJsonArray {
                add(buildJsonObject {
                    put("id", "s1")
                    put("name", "Overnight Stays")
                    put("category", "Held Down at Home")
                    put("priceCents", 15000L)
                    put("priceMinCents", JsonNull)
                    put("priceMaxCents", JsonNull)
                    put("isOvernight", true)
                    put("iconKey", "moon")
                })
            })
        })
        val res = PortalApi(fake).getServiceCatalog()
        assertEquals(1, res.services.size)
        val s = res.services[0]
        assertEquals("Overnight Stays", s.name)
        assertEquals(15000L, s.priceCents)
        assertEquals(true, s.isOvernight)
        assertEquals("Held Down at Home", s.category)
    }

    @Test
    fun `getServiceCatalog decodes ranged price services`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getServiceCatalog", buildJsonObject {
            put("services", buildJsonArray {
                add(buildJsonObject {
                    put("id", "s2")
                    put("name", "Auntie's In")
                    put("priceMinCents", 1500L)
                    put("priceMaxCents", 8000L)
                    put("isOvernight", false)
                })
            })
        })
        val s = PortalApi(fake).getServiceCatalog().services.single()
        assertEquals(1500L, s.priceMinCents)
        assertEquals(8000L, s.priceMaxCents)
        assertEquals(null, s.priceCents)
    }

    @Test
    fun `requestBookingMultiVisit forwards visits and returns batchId`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("requestBooking", buildJsonObject {
            put("batchId", "batch-1")
            put("bookingIds", buildJsonArray {
                add("batch-1")
            })
            put("bookingId", "batch-1")
        })
        val batchId = PortalApi(fake).requestBookingMultiVisit(
            kinfolkId = "3",
            kinIds = listOf("k1"),
            pattern = BookingPattern.Individual,
            visits = listOf(
                BookingVisit(startTimeMs = 1L, endTimeMs = 2L, serviceId = "s1", serviceName = "Auntie's In", priceCents = 1500L),
                BookingVisit(startTimeMs = 86_400_001L, endTimeMs = null, serviceId = "s1", serviceName = "Auntie's In", priceCents = 1500L),
            ),
            notes = "park",
        )
        assertEquals("batch-1", batchId)
        val (name, payload) = fake.calls.single()
        assertEquals("requestBooking", name)
        assertNotNull(payload)
        assertEquals(true, payload.containsKey("visits"))
    }

    @Test
    fun `requestBookingMultiVisit refuses empty visit list`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("requestBooking", buildJsonObject { put("bookingIds", buildJsonArray {}) })
        assertFailsWith<IllegalArgumentException> {
            PortalApi(fake).requestBookingMultiVisit(
                kinfolkId = "3",
                kinIds = emptyList(),
                pattern = BookingPattern.Individual,
                visits = emptyList(),
                notes = null,
            )
        }
    }
}
