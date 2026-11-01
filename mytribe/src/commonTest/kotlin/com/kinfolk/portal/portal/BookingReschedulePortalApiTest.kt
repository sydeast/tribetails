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
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The reschedule ask on the portal Android app (#469).
 *
 * `requestBookingReschedule` shipped with the web BookingDetail screen in PR
 * #436, and `getMyBookings` has carried the ask's state since. This client
 * dropped all five fields on the floor and had no way to make an ask at all.
 */
class BookingReschedulePortalApiTest {

    private val proposedMs = 1_787_058_000_000L

    private fun visit(
        rescheduleStatus: String? = null,
        proposedStartMs: Long? = null,
        proposedEndMs: Long? = null,
        reason: String? = null,
        responseNote: String? = null,
    ) = buildJsonObject {
        put("id", "v1")
        put("kinfolkId", "fam-1")
        put("status", "confirmed")
        put("batchId", "batch-1")
        put("startTimeMs", 1_786_980_600_000L)
        rescheduleStatus?.let { put("rescheduleRequestStatus", it) }
        proposedStartMs?.let { put("rescheduleRequestedStartTimeMs", it) }
        proposedEndMs?.let { put("rescheduleRequestedEndTimeMs", it) }
        reason?.let { put("rescheduleRequestReason", it) }
        responseNote?.let { put("rescheduleResponseNote", it) }
    }

    private fun stubBookings(fake: FakeFunctionsClient, visit: kotlinx.serialization.json.JsonObject) {
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray { add(visit) })
            put("recent", buildJsonArray {})
        })
    }

    // -- Making the ask --

    @Test
    fun `sends the batch, the visit, the proposed start and the reason`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("requestBookingReschedule", buildJsonObject {
            put("ok", true)
            put("visitId", "v1")
            put("proposedStartTimeMs", proposedMs)
            put("proposedEndTimeMs", proposedMs + 1_800_000L)
        })

        val res = PortalApi(fake).requestBookingReschedule(
            batchId = "batch-1",
            visitId = "v1",
            proposedStartTimeMs = proposedMs,
            reason = "  School run moved  ",
            kinfolkId = "fam-1",
        )

        assertTrue(res.ok)
        assertEquals("v1", res.visitId)
        assertEquals(proposedMs, res.proposedStartTimeMs)
        assertEquals(proposedMs + 1_800_000L, res.proposedEndTimeMs)

        val (name, payload) = fake.calls.single()
        assertEquals("requestBookingReschedule", name)
        assertEquals("batch-1", payload?.get("batchId")?.toString()?.trim('"'))
        assertEquals("v1", payload?.get("visitId")?.toString()?.trim('"'))
        assertEquals("fam-1", payload?.get("kinfolkId")?.toString()?.trim('"'))
        assertEquals(proposedMs.toString(), payload?.get("proposedStartTimeMs")?.toString())
        assertEquals("School run moved", payload?.get("reason")?.toString()?.trim('"'))
    }

    @Test
    fun `sends no end time, so the visit keeps the length it already has`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("requestBookingReschedule", buildJsonObject {
            put("ok", true)
            put("visitId", "v1")
            put("proposedStartTimeMs", proposedMs)
            put("proposedEndTimeMs", JsonNull)
        })

        val res = PortalApi(fake).requestBookingReschedule("batch-1", "v1", proposedMs)

        assertNull(res.proposedEndTimeMs)
        assertNull(fake.calls.single().second?.get("proposedEndTimeMs"))
    }

    @Test
    fun `a blank reason is left off the payload rather than sent as empty`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("requestBookingReschedule", buildJsonObject {
            put("ok", true)
            put("visitId", "v1")
            put("proposedStartTimeMs", proposedMs)
            put("proposedEndTimeMs", JsonNull)
        })

        PortalApi(fake).requestBookingReschedule("batch-1", "v1", proposedMs, reason = "   ")

        assertNull(fake.calls.single().second?.get("reason"))
    }

    @Test
    fun `a second ask while one is pending surfaces the server's refusal`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError(
            "requestBookingReschedule",
            IllegalStateException("A new time is already waiting on your Auntie for this visit."),
        )

        val failure = assertFailsWith<IllegalStateException> {
            PortalApi(fake).requestBookingReschedule("batch-1", "v1", proposedMs)
        }
        assertEquals("A new time is already waiting on your Auntie for this visit.", failure.message)
    }

    // -- Reading the ask's state back off getMyBookings --

    @Test
    fun `a pending ask decodes with the time that was proposed`() = runTest {
        val fake = FakeFunctionsClient()
        stubBookings(
            fake,
            visit(
                rescheduleStatus = "pending",
                proposedStartMs = proposedMs,
                proposedEndMs = proposedMs + 1_800_000L,
                reason = "School run moved",
            ),
        )

        val booking = PortalApi(fake).getMyBookings("fam-1").upcoming.single()

        assertEquals(RescheduleRequestStatus.Pending, booking.rescheduleRequestStatus)
        assertEquals(proposedMs, booking.rescheduleRequestedStartTimeMs)
        assertEquals(proposedMs + 1_800_000L, booking.rescheduleRequestedEndTimeMs)
        assertEquals("School run moved", booking.rescheduleRequestReason)
        assertFalse(booking.canRequestReschedule())
    }

    @Test
    fun `a declined ask keeps the office's note beside the time that was asked for`() = runTest {
        val fake = FakeFunctionsClient()
        stubBookings(
            fake,
            visit(
                rescheduleStatus = "declined",
                proposedStartMs = proposedMs,
                responseNote = "Auntie Avery is booked solid that morning.",
            ),
        )

        val booking = PortalApi(fake).getMyBookings("fam-1").upcoming.single()

        assertEquals(RescheduleRequestStatus.Declined, booking.rescheduleRequestStatus)
        assertEquals("Auntie Avery is booked solid that morning.", booking.rescheduleResponseNote)
        // A declined ask is answered, so another one is allowed.
        assertTrue(booking.canRequestReschedule())
    }

    @Test
    fun `a visit that never had an ask decodes as no ask, not as a crash`() = runTest {
        val fake = FakeFunctionsClient()
        stubBookings(fake, visit())

        val booking = PortalApi(fake).getMyBookings("fam-1").upcoming.single()

        assertNull(booking.rescheduleRequestStatus)
        assertNull(booking.rescheduleRequestedStartTimeMs)
        assertNull(booking.rescheduleRequestedEndTimeMs)
        assertNull(booking.rescheduleRequestReason)
        assertNull(booking.rescheduleResponseNote)
        assertTrue(booking.canRequestReschedule())
    }

    @Test
    fun `a status this client does not model reads as no ask`() = runTest {
        val fake = FakeFunctionsClient()
        stubBookings(fake, visit(rescheduleStatus = "escalated"))

        val booking = PortalApi(fake).getMyBookings("fam-1").upcoming.single()

        assertNull(booking.rescheduleRequestStatus)
    }

    @Test
    fun `a visit with no booking envelope cannot be proposed for`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {
                add(buildJsonObject {
                    put("id", "v9")
                    put("kinfolkId", "fam-1")
                    put("status", "confirmed")
                    put("startTimeMs", 1_786_980_600_000L)
                })
            })
            put("recent", buildJsonArray {})
        })

        val booking = PortalApi(fake).getMyBookings("fam-1").upcoming.single()

        assertNull(booking.batchId)
        assertFalse(booking.canRequestReschedule())
    }

    @Test
    fun `a completed visit is past asking for a new time`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {})
            put("recent", buildJsonArray {
                add(buildJsonObject {
                    put("id", "v2")
                    put("kinfolkId", "fam-1")
                    put("status", "completed")
                    put("batchId", "batch-1")
                })
            })
        })

        val booking = PortalApi(fake).getMyBookings("fam-1").recent.single()

        assertFalse(booking.canRequestReschedule())
    }

    // -- #1284: the window the new time sits in --
    @Test
    fun `sends the time block id when the new time rides a block`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("requestBookingReschedule", buildJsonObject {
            put("ok", true)
            put("visitId", "v1")
            put("proposedStartTimeMs", proposedMs)
            put("proposedEndTimeMs", JsonNull)
        })
        PortalApi(fake).requestBookingReschedule("batch-1", "v1", proposedMs, timeBlockId = "morning")
        assertEquals("morning", fake.calls.single().second?.get("timeBlockId")?.toString()?.trim('"'))
    }
    @Test
    fun `a clock time sends no time block id`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("requestBookingReschedule", buildJsonObject {
            put("ok", true)
            put("visitId", "v1")
            put("proposedStartTimeMs", proposedMs)
            put("proposedEndTimeMs", JsonNull)
        })
        PortalApi(fake).requestBookingReschedule("batch-1", "v1", proposedMs, timeBlockId = "  ")
        assertNull(fake.calls.single().second?.get("timeBlockId"))
    }
    @Test
    fun `a visit carries the service it was booked as`() = runTest {
        val fake = FakeFunctionsClient()
        stubBookings(fake, buildJsonObject {
            put("id", "v1")
            put("kinfolkId", "fam-1")
            put("status", "confirmed")
            put("serviceId", "overnight")
        })
        assertEquals("overnight", PortalApi(fake).getMyBookings("fam-1").upcoming.single().serviceId)
        stubBookings(fake, visit())
        assertNull(PortalApi(fake).getMyBookings("fam-1").upcoming.single().serviceId)
    }
    @Test
    fun `the business calendar decodes closures, a seven day table and the zone`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getBusinessClosures", buildJsonObject {
            put("closures", buildJsonArray {
                add(buildJsonObject { put("date", "2026-11-26"); put("name", "Thanksgiving") })
            })
            put("weeklyHours", buildJsonArray {
                for (d in 0..6) add(buildJsonObject {
                    put("weekday", d)
                    put("open", d != 0)
                    if (d != 0) { put("startTime", "09:00"); put("endTime", "17:00") } else { put("startTime", JsonNull); put("endTime", JsonNull) }
                })
            })
            put("timeZone", "America/Chicago")
        })
        val cal = PortalApi(fake).getBusinessCalendar("2026-11-01", "2026-12-01")
        assertEquals(listOf(BusinessClosure("2026-11-26", "Thanksgiving")), cal.closures)
        assertEquals(7, cal.weeklyHours.size)
        assertEquals(WeekdayHours(0, false, null, null), cal.weeklyHours[0])
        assertEquals(WeekdayHours(1, true, "09:00", "17:00"), cal.weeklyHours[1])
        assertEquals("America/Chicago", cal.timeZone)
    }
    @Test
    fun `a partial hours table is dropped rather than read as closed days`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getBusinessClosures", buildJsonObject {
            put("closures", buildJsonArray {})
            put("weeklyHours", buildJsonArray {
                add(buildJsonObject { put("weekday", 1); put("open", true); put("startTime", "09:00"); put("endTime", "17:00") })
            })
        })
        val cal = PortalApi(fake).getBusinessCalendar("2026-11-01", "2026-12-01")
        assertTrue(cal.weeklyHours.isEmpty())
        assertEquals("", cal.timeZone)
    }
    @Test
    fun `an older server with neither field still gives the closures`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getBusinessClosures", buildJsonObject {
            put("closures", buildJsonArray {
                add(buildJsonObject { put("date", "2026-11-26"); put("name", "") })
            })
        })
        val closures = PortalApi(fake).getBusinessClosures("2026-11-01", "2026-12-01")
        assertEquals(listOf(BusinessClosure("2026-11-26", "Closed")), closures)
    }
    // -- #1283: the notes read back --
    @Test
    fun `getBookingNotes sends the visit and decodes the booking note and each saved note`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getBookingNotes", buildJsonObject {
            put("bookingNote", "Gate sticks, lift and pull.")
            put("notes", buildJsonArray {
                add(buildJsonObject { put("id", "n1"); put("body", "Back door"); put("createdAtMs", 1_786_980_600_000L) })
                add(buildJsonObject { put("id", "n2"); put("body", "No time on this one"); put("createdAtMs", JsonNull) })
                add(buildJsonObject { put("id", ""); put("body", "dropped: no id") })
            })
        })
        val res = PortalApi(fake).getBookingNotes(batchId = "batch-1", visitId = "v1", kinfolkId = "fam-1")
        assertEquals("Gate sticks, lift and pull.", res.bookingNote)
        assertEquals(
            listOf(
                BookingNote("n1", "Back door", 1_786_980_600_000L),
                BookingNote("n2", "No time on this one", null),
            ),
            res.notes,
        )
        val (name, payload) = fake.calls.single()
        assertEquals("getBookingNotes", name)
        assertEquals("batch-1", payload?.get("batchId")?.toString()?.trim('"'))
        assertEquals("v1", payload?.get("visitId")?.toString()?.trim('"'))
        assertEquals("fam-1", payload?.get("kinfolkId")?.toString()?.trim('"'))
    }
    @Test
    fun `getBookingNotes reads an empty answer as nothing yet`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getBookingNotes", buildJsonObject {
            put("bookingNote", JsonNull)
            put("notes", buildJsonArray {})
        })
        val res = PortalApi(fake).getBookingNotes("batch-1", "v1")
        assertNull(res.bookingNote)
        assertTrue(res.notes.isEmpty())
    }
}
