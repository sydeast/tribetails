package com.tribetails.auntieos.data.contracts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The generated booking Contracts module, exercised where Kotlin actually
 * runs (ADR-0001 decision 2; the booking family joined it under ADR-0003's
 * follow-up).
 *
 * `mytribe/functions/test/contractsCodegen.test.ts` pins the emitted SOURCE
 * for this family the same way it does for invoices. This file pins its
 * BEHAVIOUR: the emitted source is only interesting if a junk payload
 * degrades rather than throwing, because a callable response arrives after
 * the server write has already committed (see `InvoiceContractsGeneratedTest`
 * for the full reasoning; it applies unchanged here).
 *
 * The three drift fixes this follow-up made (`BookingRepository`,
 * `KinCareRepository`, `AuntieRepository`) are exercised where THEY live, not
 * here: this file is the decoder's own contract, not the repositories'.
 */
class BookingContractsGeneratedTest {

    // ── getMyBookings: the nested envelope/visit shape ──────────────────────

    @Test
    fun `a null getMyBookings payload decodes to neutral values rather than throwing`() {
        val result = decodeGetMyBookingsResult(null)
        assertNull(result.liveVisit)
        assertEquals(emptyList<GetMyBookingsResultLiveVisit>(), result.upcoming)
        assertEquals(emptyList<GetMyBookingsResultLiveVisit>(), result.recent)
        assertEquals(emptyList<GetMyBookingsResultEnvelope>(), result.envelopes)
    }

    @Test
    fun `an empty getMyBookings payload decodes the same as a null one`() {
        assertEquals(decodeGetMyBookingsResult(null), decodeGetMyBookingsResult(emptyMap()))
    }

    @Test
    fun `a wrong-typed getMyBookings payload fail-softs instead of throwing`() {
        val junk = mapOf<String, Any?>(
            "liveVisit" to "not-a-map",
            "upcoming" to "not-a-list",
            "recent" to listOf("not-a-visit", 42),
            "envelopes" to null,
        )
        val result = decodeGetMyBookingsResult(junk)
        assertNull(result.liveVisit)
        assertEquals(emptyList<GetMyBookingsResultLiveVisit>(), result.upcoming)
        assertEquals(emptyList<GetMyBookingsResultLiveVisit>(), result.recent)
        assertEquals(emptyList<GetMyBookingsResultEnvelope>(), result.envelopes)
    }

    @Test
    fun `a real getMyBookings response decodes field for field, envelope and visits`() {
        val visit = mapOf(
            "id" to "vis1",
            "batchId" to "batch1",
            "kinfolkId" to "kf1",
            "status" to "confirmed",
            "serviceType" to "Dog Walking",
            "title" to "Morning walk",
            "startTimeMs" to 1785765600000L,
            "endTimeMs" to null,
            "kinIds" to listOf("kin1"),
            "kinNames" to listOf("Fido"),
            "auntieDisplayName" to "Jamie",
            "auntieAvatarUrl" to null,
            "notes" to null,
            "requestedByUid" to "u1",
            "createdAtMs" to 1785000000000L,
            "updatedAtMs" to 1785000000000L,
            "visitProgress" to null,
            "sourceBookingId" to null,
            "sessionId" to null,
            "cancelRequested" to false,
        )
        val result = decodeGetMyBookingsResult(
            mapOf(
                "liveVisit" to null,
                "upcoming" to listOf(visit),
                "recent" to emptyList<Any>(),
                "envelopes" to listOf(
                    mapOf(
                        "batchId" to "batch1",
                        "envelopeStatus" to "confirmed",
                        "pattern" to "individual",
                        "serviceName" to "Dog Walking",
                        "kinIds" to listOf("kin1"),
                        "kinNames" to listOf("Fido"),
                        "notes" to null,
                        "visitCount" to 1,
                        "confirmedCount" to 1,
                        "completedCount" to 0,
                        "firstStartTimeMs" to 1785765600000L,
                        "lastStartTimeMs" to 1785765600000L,
                        "kinCares" to listOf(visit),
                    ),
                ),
            ),
        )
        assertNull(result.liveVisit)
        assertEquals(1, result.upcoming.size)
        assertEquals("vis1", result.upcoming[0].id)
        assertEquals("confirmed", result.upcoming[0].status)
        assertEquals(1785765600000L, result.upcoming[0].startTimeMs)
        assertFalse(result.upcoming[0].cancelRequested)
        assertEquals(1, result.envelopes.size)
        assertEquals("batch1", result.envelopes[0].batchId)
        assertEquals(1, result.envelopes[0].kinCares.size)
        assertEquals("vis1", result.envelopes[0].kinCares[0].id)
    }

    // ── createMultiDateBookingRequest ────────────────────────────────────────

    @Test
    fun `a null createMultiDateBookingRequest payload decodes to neutral values`() {
        val result = decodeCreateMultiDateBookingRequestResult(null)
        assertEquals("", result.batchId)
        assertEquals(emptyList<String>(), result.visitIds)
        assertEquals(0L, result.visitCount)
    }

    @Test
    fun `a wrong-typed createMultiDateBookingRequest payload fail-softs`() {
        val junk = mapOf<String, Any?>(
            "batchId" to 42,
            "visitIds" to listOf("v1", 2, null, "v2"),
            "visitCount" to "not-a-number",
        )
        val result = decodeCreateMultiDateBookingRequestResult(junk)
        assertEquals("", result.batchId)
        assertEquals(listOf("v1", "v2"), result.visitIds)
        assertEquals(0L, result.visitCount)
    }

    @Test
    fun `a real createMultiDateBookingRequest response decodes field for field`() {
        val result = decodeCreateMultiDateBookingRequestResult(
            mapOf("batchId" to "batch9", "visitIds" to listOf("v1", "v2"), "visitCount" to 2),
        )
        assertEquals("batch9", result.batchId)
        assertEquals(listOf("v1", "v2"), result.visitIds)
        assertEquals(2L, result.visitCount)
    }

    @Test
    fun `the generated encoder always sends the always-present visit fields, null when unset`() {
        // The ADR-0003 follow-up narrowing: endTimeMs/serviceId/priceCents are
        // always-present-but-nullable in the generated Args, never omitted.
        val visit = CreateMultiDateBookingRequestArgsVisit(
            startTimeMs = 1L,
            endTimeMs = null,
            serviceId = null,
            serviceName = "Dog Walking",
            priceCents = null,
        )
        val payload = visit.toPayload()
        assertTrue(payload.containsKey("endTimeMs"))
        assertTrue(payload.containsKey("serviceId"))
        assertTrue(payload.containsKey("priceCents"))
        assertNull(payload["endTimeMs"])
        assertNull(payload["serviceId"])
        // A visit carries no address (operator ruling, 2026-08-04): the
        // household doc is where an address lives, so the generated encoder has
        // no key to send even if a caller wanted one.
        assertFalse(payload.containsKey("location"))
    }

    // ── batchUpdateBookings: the failed[] array ──────────────────────────────

    @Test
    fun `a null batchUpdateBookings payload decodes to neutral values`() {
        val result = decodeBatchUpdateBookingsResult(null)
        assertFalse(result.ok)
        assertEquals("", result.action)
        assertEquals(0L, result.updated)
        assertEquals(emptyList<BatchUpdateBookingsResultFailed>(), result.failed)
    }

    @Test
    fun `batchUpdateBookings drops non-map failed entries but keeps a map missing id`() {
        // This is the exact case AuntieRepository's decodeBatchBookingResult
        // wrapper additionally filters (see StageTwoTailDecodeTest): the
        // GENERATED decoder alone keeps a map with no "id" (decodes id to ""),
        // and only drops entries that are not maps at all.
        val junk = mapOf<String, Any?>(
            "ok" to true,
            "action" to "REJECT",
            "updated" to 1,
            "failed" to listOf(
                mapOf("id" to "v1", "error" to "x"),
                mapOf("error" to "no-id-here"),
                "not-a-map",
            ),
        )
        val result = decodeBatchUpdateBookingsResult(junk)
        assertTrue(result.ok)
        assertEquals("REJECT", result.action)
        assertEquals(1L, result.updated)
        assertEquals(2, result.failed.size)
        assertEquals("v1", result.failed[0].id)
        assertEquals("", result.failed[1].id)
    }

    // ── manageBookingSeries ───────────────────────────────────────────────────

    @Test
    fun `a null manageBookingSeries payload decodes ok false and empty strings`() {
        val result = decodeManageBookingSeriesResult(null)
        assertFalse(result.ok)
        assertEquals("", result.action)
        assertEquals("", result.batchId)
        assertEquals(0L, result.affectedVisits)
        assertEquals(0L, result.sessionsCreated)
        assertEquals(0L, result.failedVisits)
    }

    @Test
    fun `a real manageBookingSeries response decodes field for field, including ok action batchId`() {
        // These three fields are exactly what the ADR-0003 follow-up fixed
        // AuntieRepository.manageBookingSeries to actually read, instead of
        // decoding and discarding.
        val result = decodeManageBookingSeriesResult(
            mapOf(
                "ok" to true,
                "action" to "APPROVE",
                "batchId" to "batch1",
                "affectedVisits" to 3,
                "sessionsCreated" to 3,
                "failedVisits" to 0,
            ),
        )
        assertTrue(result.ok)
        assertEquals("APPROVE", result.action)
        assertEquals("batch1", result.batchId)
        assertEquals(3L, result.affectedVisits)
        assertEquals(3L, result.sessionsCreated)
        assertEquals(0L, result.failedVisits)
    }

    @Test
    fun `manageBookingSeries ok fail-softs to false rather than throwing on a wrong type`() {
        val result = decodeManageBookingSeriesResult(mapOf("ok" to "yes", "action" to 7))
        assertFalse(result.ok)
        assertEquals("", result.action)
    }

    // ── rescheduleBooking ─────────────────────────────────────────────────────

    @Test
    fun `a null rescheduleBooking payload decodes ok false, never throws`() {
        val result = decodeRescheduleBookingResult(null)
        assertFalse(result.ok)
        assertEquals("", result.sessionId)
    }

    @Test
    fun `a real rescheduleBooking response decodes ok and sessionId`() {
        // What the ADR-0003 follow-up fixed KinCareRepository.rescheduleBooking
        // to actually read, instead of discarding the response as Result<Unit>.
        val result = decodeRescheduleBookingResult(mapOf("ok" to true, "sessionId" to "sess1"))
        assertTrue(result.ok)
        assertEquals("sess1", result.sessionId)
    }
}
