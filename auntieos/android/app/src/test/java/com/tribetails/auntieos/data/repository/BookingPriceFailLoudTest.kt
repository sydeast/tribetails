package com.tribetails.auntieos.data.repository

import com.tribetails.auntieos.data.model.*
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

/**
 * calculateBookingPrice reads five things from ServiceRepository. Only the base
 * service ever failed loud; the other four swallowed their failure and returned
 * a confident Result.success carrying a WRONG NUMBER:
 *
 *   - surcharges read fails  -> weekend/after-hours fees vanish -> we undercharge
 *   - discounts read fails   -> earned discounts vanish -> we overcharge the household
 *   - supplementals fail     -> add-ons the operator just ticked drop off the total
 *   - promo read fails       -> indistinguishable from "no such code", kinfolk loses it
 *
 * No banner, no error, just a plausible total. That is exactly the silent
 * degradation the project policy forbids, on the money path.
 *
 * The distinction these tests pin: a FAILED READ is an error, but genuinely
 * ABSENT data is not. An empty surcharge table and an unreadable surcharge table
 * must not produce the same answer.
 *
 * BookingRepository takes BOTH `firestore` and `functions` via constructor, and
 * calculateBookingPrice touches neither (only serviceRepo), so this runs as a
 * plain JVM test with both mocked. The note in BookingRepositoryTest about
 * needing Robolectric here is stale: nothing in this path reaches Firebase.
 */
class BookingPriceFailLoudTest {

    private val repo = BookingRepository(
        firestore = mockk(relaxed = true),
        functions = mockk(relaxed = true),
    )

    private val BASE = BaseService(id = "svc1", title = "Dog Walk", basePrice = 40.0)

    /** A serviceRepo where every read succeeds and returns nothing. The happy baseline. */
    private fun okRepo(): ServiceRepository = mockk<ServiceRepository>().apply {
        coEvery { getBaseServiceById("svc1") } returns Result.success(BASE)
        coEvery { getSupplementalServices(any()) } returns Result.success(emptyList())
        coEvery { getSurcharges(any()) } returns Result.success(emptyList())
        coEvery { getDiscounts(any()) } returns Result.success(emptyList())
        coEvery { getPromoCodeByCode(any()) } returns Result.success(null)
    }

    private suspend fun price(
        repo2: ServiceRepository,
        promo: String? = null,
        supp: List<String> = emptyList(),
    ) = repo.calculateBookingPrice(
        baseServiceId = "svc1",
        supplementalServiceIds = supp,
        startDateTime = "2026-07-18T19:00:00",
        endDateTime = "2026-07-18T20:00:00",
        kinfolkId = "k1",
        promoCode = promo,
        serviceRepo = repo2,
    )

    // ---- the baseline still has to work ------------------------------------

    @Test
    fun `all reads succeed - price is calculated and returned`() = runTest {
        val result = price(okRepo())
        assertTrue("expected success when every read succeeds", result.isSuccess)
        assertEquals(40.0, result.getOrThrow().finalTotal, 0.001)
    }

    @Test
    fun `empty tables are NOT an error - absent data is a real answer`() = runTest {
        // Every read succeeds but returns nothing. That is a business with no
        // surcharges configured, not a broken read. Must still price the booking.
        val result = price(okRepo())
        assertTrue(result.isSuccess)
        assertEquals(0.0, result.getOrThrow().surchargesTotal, 0.001)
        assertEquals(0.0, result.getOrThrow().discountsTotal, 0.001)
    }

    @Test
    fun `promo code that genuinely does not exist is NOT an error`() = runTest {
        val sr = okRepo()
        coEvery { sr.getPromoCodeByCode("NOPE") } returns Result.success(null)
        val result = price(sr, promo = "NOPE")
        assertTrue("a typo'd promo code must not fail the quote", result.isSuccess)
        assertEquals(0.0, result.getOrThrow().promoCodeDiscount, 0.001)
    }

    // ---- a failed read must never become a wrong number ---------------------

    @Test
    fun `surcharge read failure fails the quote instead of silently undercharging`() = runTest {
        val sr = okRepo()
        coEvery { sr.getSurcharges(any()) } returns Result.failure(RuntimeException("firestore unavailable"))

        val result = price(sr)

        assertTrue(
            "a failed surcharge read must not return a confident total that omits surcharges",
            result.isFailure,
        )
    }

    @Test
    fun `discount read failure fails the quote instead of silently overcharging`() = runTest {
        val sr = okRepo()
        coEvery { sr.getDiscounts(any()) } returns Result.failure(RuntimeException("firestore unavailable"))

        val result = price(sr)

        assertTrue(
            "a failed discount read must not return a total that overcharges the household",
            result.isFailure,
        )
    }

    @Test
    fun `supplemental read failure fails the quote instead of dropping the operator's add-ons`() = runTest {
        val sr = okRepo()
        coEvery { sr.getSupplementalServices(any()) } returns Result.failure(RuntimeException("firestore unavailable"))

        val result = price(sr, supp = listOf("addon1"))

        assertTrue(
            "add-ons were explicitly selected; a failed read must not silently zero them",
            result.isFailure,
        )
    }

    @Test
    fun `promo read failure fails the quote instead of looking like an unknown code`() = runTest {
        val sr = okRepo()
        coEvery { sr.getPromoCodeByCode("SAVE10") } returns Result.failure(RuntimeException("firestore unavailable"))

        val result = price(sr, promo = "SAVE10")

        assertTrue(
            "a failed promo read is not the same as 'no such promo' and must not be swallowed",
            result.isFailure,
        )
    }

    @Test
    fun `the surfaced error names the read that failed, so the operator can act`() = runTest {
        val sr = okRepo()
        coEvery { sr.getSurcharges(any()) } returns Result.failure(RuntimeException("firestore unavailable"))

        val msg = price(sr).exceptionOrNull()?.message.orEmpty()

        assertTrue("error should say what failed, was: '$msg'", msg.contains("surcharge", ignoreCase = true))
    }

    // ---- the existing loud path must stay loud ------------------------------

    @Test
    fun `missing base service still fails, unchanged`() = runTest {
        val sr = okRepo()
        coEvery { sr.getBaseServiceById("svc1") } returns Result.success(null)
        assertTrue(price(sr).isFailure)
    }
}
