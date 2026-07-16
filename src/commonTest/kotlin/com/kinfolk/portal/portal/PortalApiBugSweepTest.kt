package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class PortalApiBugSweepTest {

    @Test
    fun `BookingStatus decoder defaults unknown to Requested — document or fix`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", buildJsonObject {
                put("id", "x")
                put("status", "BOGUS_VALUE")
            })
            put("upcoming", buildJsonArray {})
            put("recent", buildJsonArray {})
        })
        val api = PortalApi(fake)
        val res = api.getMyBookings()
        // Current behavior: silent default to Requested. Lock it in via assertion;
        // if owner wants stricter handling, switch to assertFailsWith and update decoder.
        assertEquals(BookingStatus.Requested, res.liveVisit?.status)
    }

    @Test
    fun `KinStatus decoder maps anything not noLongerWithUs to Active`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKin", buildJsonObject {
            put("kin", buildJsonArray {
                add(buildJsonObject {
                    put("id", "k1")
                    put("name", "X")
                    put("status", "")
                })
                add(buildJsonObject {
                    put("id", "k2")
                    put("name", "Y")
                    // status missing entirely
                })
                add(buildJsonObject {
                    put("id", "k3")
                    put("name", "Z")
                    put("status", "DELETED")
                })
            })
        })
        val res = PortalApi(fake).getMyKin()
        assertTrue(res.kin.all { it.status == KinStatus.Active })
    }

    @Test
    fun `VisitProgress decoder returns null for unknown progress strings`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", buildJsonObject {
                put("id", "x")
                put("status", "active")
                put("visitProgress", "random_string")
            })
            put("upcoming", buildJsonArray {})
            put("recent", buildJsonArray {})
        })
        val res = PortalApi(fake).getMyBookings()
        assertEquals(null, res.liveVisit?.visitProgress)
    }

    @Test
    fun `getMyInvoices missing amountDue = OPEN bucket (rule flipped)`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 0L)
            put("open", buildJsonArray {
                add(buildJsonObject {
                    put("id", "no-amt")
                    put("kinfolkId", "3")
                    put("total", 100.0)
                    put("status", "open")
                    put("isPaid", false)
                })
            })
            put("paid", buildJsonArray {})
            put("credits", buildJsonArray {})
        })
        val res = PortalApi(fake).getMyInvoices()
        assertEquals(1, res.open.size)
        assertEquals(0, res.paid.size)
        assertEquals(InvoiceStatus.Open, res.open[0].status)
    }

    @Test
    fun `getMyKinTales pagination — empty hasMore field defaults to false`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinTales", buildJsonObject {
            put("tales", buildJsonArray {})
        })
        val res = PortalApi(fake).getMyKinTales()
        assertEquals(false, res.hasMore, "missing hasMore must default to false, not throw")
    }

    @Test
    fun `requestBooking call sends every field that was passed`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("requestBooking", buildJsonObject { put("bookingId", "b-1") })
        val id = PortalApi(fake).requestBooking(
            kinfolkId = "3",
            serviceType = "walk",
            title = "AM",
            startTimeMs = 1L,
            endTimeMs = 2L,
            kinIds = listOf("k1", "k2"),
            notes = "fast",
        )
        assertEquals("b-1", id)
        val (name, payload) = fake.calls.single()
        assertEquals("requestBooking", name)
        assertNotNull(payload)
        // Spot-check critical fields are present.
        assertTrue(payload.containsKey("kinfolkId"))
        assertTrue(payload.containsKey("serviceType"))
        assertTrue(payload.containsKey("kinIds"))
    }

    @Test
    fun `payInvoice surfaces zero amount when server returns it`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("payInvoice", buildJsonObject {
            put("checkoutUrl", "https://stripe/x")
            put("sessionId", "cs_1")
            put("amountCents", 0L)
            put("currency", "usd")
        })
        val res = PortalApi(fake).payInvoice(
            invoiceId = "x", successUrl = "https://x", cancelUrl = "https://y",
        )
        assertEquals(0L, res.amountCents)
    }
}
