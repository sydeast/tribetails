package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.FirebaseFunctionsException
import com.google.firebase.functions.HttpsCallableReference
import com.google.firebase.functions.HttpsCallableResult
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #644, the Android half.
 *
 * #630 caught Cloud Run dropping a booking request before it reached the
 * container, and the SDK reported it as `INTERNAL` -- the same code it reports
 * when the booking WAS written and only the reply was lost. This client cannot
 * tell those apart, so retrying is safe only because the payload names the
 * booking: the server recognises the second attempt as the same submission and
 * returns what it already stored.
 *
 * What these tests pin is the coupling between those two facts. The retry must
 * exist when the key does, must NOT exist when it does not, and must send the
 * identical payload -- a retry that re-minted the key would be a brand new
 * booking, which is the double-booking #630 refused to risk.
 */
class BookingRepositoryIdempotencyTest {

    private val OK = mapOf("batchId" to "req_1756400000000_a1b2c3", "visitIds" to listOf("v1"), "visitCount" to 1)
    private val KEY = "req_1756400000000_a1b2c3"

    private fun repoWith(functions: FirebaseFunctions): BookingRepository =
        BookingRepository(firestore = mockk<FirebaseFirestore>(), functions = functions)

    private fun internalFailure(): FirebaseFunctionsException =
        mockk<FirebaseFunctionsException>(relaxed = true).also {
            every { it.code } returns FirebaseFunctionsException.Code.INTERNAL
        }

    private fun refusal(code: FirebaseFunctionsException.Code): FirebaseFunctionsException =
        mockk<FirebaseFunctionsException>(relaxed = true).also { every { it.code } returns code }

    /**
     * Answers the callable with [failures] rejections, then the success. Every
     * payload it is handed is recorded, so a test can assert the retry sent the
     * same one rather than merely that it happened.
     */
    private fun stubFailingThenOk(
        functions: FirebaseFunctions,
        failures: Int,
        error: FirebaseFunctionsException,
    ): MutableList<Map<String, Any?>> {
        val ref = mockk<HttpsCallableReference>()
        val seen = mutableListOf<Map<String, Any?>>()
        val payload = slot<Map<String, Any?>>()
        val callResult = mockk<HttpsCallableResult>(relaxed = true)
        every { callResult.getData() } returns OK
        every { ref.call(capture(payload)) } answers {
            seen.add(payload.captured)
            if (seen.size <= failures) Tasks.forException(error) else Tasks.forResult(callResult)
        }
        every { functions.getHttpsCallable("createMultiDateBookingRequest") } returns ref
        return seen
    }

    private fun visits() = listOf(NewBookingVisit(startTimeMs = 1_000L, serviceName = "Dog Walking"))

    @Test
    fun `the key reaches the wire when the caller supplies one`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val seen = stubFailingThenOk(functions, failures = 0, error = internalFailure())

        repoWith(functions).createMultiDateBookingRequest(
            kinfolkId = "kf1", visits = visits(), idempotencyKey = KEY,
        )

        assertEquals(KEY, seen[0]["idempotencyKey"])
    }

    @Test
    fun `a dropped request is retried once, with the identical payload`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val seen = stubFailingThenOk(functions, failures = 1, error = internalFailure())

        val result = repoWith(functions).createMultiDateBookingRequest(
            kinfolkId = "kf1", visits = visits(), idempotencyKey = KEY,
        )

        assertTrue("the retry should have succeeded", result.isSuccess)
        assertEquals(2, seen.size)
        // The same key both times: this is the whole mechanism. A re-minted key
        // would make the second attempt a second booking.
        assertEquals(seen[0], seen[1])
        assertEquals(KEY, seen[1]["idempotencyKey"])
    }

    @Test
    fun `it retries ONCE, not until it works`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val seen = stubFailingThenOk(functions, failures = 5, error = internalFailure())

        val result = repoWith(functions).createMultiDateBookingRequest(
            kinfolkId = "kf1", visits = visits(), idempotencyKey = KEY,
        )

        // A service that is genuinely down has to surface to the operator, not
        // become a client that keeps trying.
        assertTrue("a second failure must reach the caller", result.isFailure)
        assertEquals(2, seen.size)
    }

    @Test
    fun `a request with no key is never retried`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val seen = stubFailingThenOk(functions, failures = 1, error = internalFailure())

        val result = repoWith(functions).createMultiDateBookingRequest(kinfolkId = "kf1", visits = visits())

        // Without the key the server dedupes nothing, so a retry here IS the
        // double booking. One attempt, and the failure is reported.
        assertTrue(result.isFailure)
        assertEquals(1, seen.size)
    }

    @Test
    fun `a refusal that is not INTERNAL is never retried, key or no key`() = runBlocking {
        val functions = mockk<FirebaseFunctions>()
        val seen = stubFailingThenOk(
            functions, failures = 1, error = refusal(FirebaseFunctionsException.Code.INVALID_ARGUMENT),
        )

        val result = repoWith(functions).createMultiDateBookingRequest(
            kinfolkId = "kf1", visits = visits(), idempotencyKey = KEY,
        )

        // The server answered. Sending the same rejected booking again would
        // only be refused again.
        assertTrue(result.isFailure)
        assertEquals(1, seen.size)
    }

    @Test
    fun `a minted key is the id shape the server mints`() {
        // A bare uuid is refused outright by the callable's zod guard, so a
        // wrong shape here is a booking that cannot be made at all.
        assertTrue(
            mintBookingIdempotencyKey(nowMs = 1_756_400_000_000L).matches(
                Regex("^req_[0-9]{10,16}_[a-z0-9]{1,16}$"),
            ),
        )
    }
}
