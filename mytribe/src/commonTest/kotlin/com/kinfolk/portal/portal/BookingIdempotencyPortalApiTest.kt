package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #644, the portal Android app's half.
 *
 * #630 caught Cloud Run dropping a booking request before it reached the
 * container, reported the same way as a booking that was written and lost only
 * its reply. The key is what lets the server tell the two apart, so a second
 * attempt returns the first attempt's booking rather than making another.
 *
 * The portal is where a duplicate costs most: with `autoConfirmRepeatKinfolk`
 * on, a duplicated request is approved on arrival, so the household gets a
 * second set of CONFIRMED sessions rather than a stray queue entry.
 *
 * This client does not retry on its own -- `FunctionsClient.call` throws a plain
 * `Throwable` with no code, so it cannot tell a dropped request from a refusal.
 * What it must get right is putting the key on the wire when it has one, and
 * leaving the payload untouched when it does not.
 */
class BookingIdempotencyPortalApiTest {

    private val KEY = "req_1756400000000_a1b2c3"

    @Test
    fun multiVisit_sendsTheKeyWhenTheCallerSuppliesOne() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("requestBooking", buildJsonObject { put("batchId", KEY) })
        PortalApi(fake).requestBookingMultiVisit(
            kinfolkId = "kf1",
            visits = listOf(BookingVisit(1_900_000_000_000, null, "s1", "Walk", 1000)),
            idempotencyKey = KEY,
        )
        assertEquals(KEY, fake.calls.single().second!!["idempotencyKey"]!!.jsonPrimitive.content)
    }

    @Test
    fun multiVisit_omitsTheKeyEntirelyWhenTheCallerHasNone() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("requestBooking", buildJsonObject { put("batchId", "req_2") })
        PortalApi(fake).requestBookingMultiVisit(
            kinfolkId = "kf1",
            visits = listOf(BookingVisit(1_900_000_000_000, null, "s1", "Walk", 1000)),
        )
        // Absent, not null: the callable's zod guard refuses an explicit null,
        // and an unkeyed request must behave exactly as it did before #644.
        assertTrue(!fake.calls.single().second!!.containsKey("idempotencyKey"))
    }

    @Test
    fun legacySingleVisit_sendsTheKeyToo() = runTest {
        // The legacy shape writes the same envelope through the same server-side
        // writer, so leaving it unkeyed would mean one of the two branches could
        // still double-book.
        val fake = FakeFunctionsClient()
        fake.stub("requestBooking", buildJsonObject { put("bookingId", KEY) })
        PortalApi(fake).requestBooking(
            kinfolkId = "kf1",
            serviceType = "Walk",
            startTimeMs = 1_900_000_000_000,
            idempotencyKey = KEY,
        )
        assertEquals(KEY, fake.calls.single().second!!["idempotencyKey"]!!.jsonPrimitive.content)
    }

    @Test
    fun mintsTheIdShapeTheServerMints() {
        // A bare uuid is refused outright by the callable's zod guard, so a
        // wrong shape here is a booking that cannot be made at all.
        assertTrue(Regex("^req_[0-9]{10,16}_[a-z0-9]{1,16}$").matches(mintBookingIdempotencyKey()))
    }
}
