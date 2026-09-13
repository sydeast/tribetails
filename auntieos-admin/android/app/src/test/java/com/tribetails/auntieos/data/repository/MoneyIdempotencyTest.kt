package com.tribetails.auntieos.data.repository

import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #825: the shape of the four money keys, AuntieOS Android.
 *
 * THE SHAPE IS A CONTRACT, NOT A CONVENTION. Each of these values becomes a
 * Firestore document id, and the callables guard them with zod regexes built by
 * `sendIdempotencyKeyRe` in `mytribe/functions/src/lib/sendIdempotency.ts`:
 * `<prefix>_<10-16 digits>_<1-16 chars of [a-z0-9]>`. A key that misses it is
 * refused with `invalid-argument`, which on the phone reads as a payment the
 * server would not take. So the regexes below are transcribed from the server's
 * and asserted here, where a mistake costs a red test instead of a red screen.
 *
 * The PREFIXES matter as much as the shape. `createInvoice` and `createQuote`
 * write into the SAME `invoices` collection, so `inv` and `quot` are what stop a
 * key minted for one being replayed at the other — where it would answer with a
 * document that is not the one being asked about.
 *
 * [nowMs] and [random] are injected here for the same reason
 * `SendIdempotency.kt` takes them: a minting function whose only inputs are the
 * clock and a global RNG can be exercised only by assertions about its shape,
 * never about its value.
 */
class MoneyIdempotencyTest {

    /** Exactly the server's guard: `^<prefix>_\d{10,16}_[a-z0-9]{1,16}$`. */
    private fun serverGuard(prefix: String) = Regex("^${prefix}_\\d{10,16}_[a-z0-9]{1,16}$")

    /** A fixed clock in the 13-digit era these keys live in, and a seeded RNG. */
    private val nowMs = 1_789_000_000_000L

    private fun seeded() = Random(7)

    @Test
    fun `every minted key satisfies the guard the server refuses everything else with`() {
        assertTrue(mintPaymentIdempotencyKey(nowMs, seeded()).matches(serverGuard("pay")))
        assertTrue(mintInvoicePaymentIdempotencyKey(nowMs, seeded()).matches(serverGuard("ipay")))
        assertTrue(mintInvoiceIdempotencyKey(nowMs, seeded()).matches(serverGuard("inv")))
        assertTrue(mintQuoteIdempotencyKey(nowMs, seeded()).matches(serverGuard("quot")))
    }

    /**
     * The prefix is the only thing keeping a quote's key out of `createInvoice`,
     * so it is asserted literally rather than inferred from the guard above.
     */
    @Test
    fun `each callable gets its own prefix, because two of them share a collection`() {
        assertTrue(mintPaymentIdempotencyKey(nowMs, seeded()).startsWith("pay_"))
        assertTrue(mintInvoicePaymentIdempotencyKey(nowMs, seeded()).startsWith("ipay_"))
        assertTrue(mintInvoiceIdempotencyKey(nowMs, seeded()).startsWith("inv_"))
        assertTrue(mintQuoteIdempotencyKey(nowMs, seeded()).startsWith("quot_"))
    }

    /**
     * `pay` is a SUFFIX of `ipay`, so a guard that were not anchored at `^` would
     * accept an `ipay_` key as a payment key — and hand `recordPayment` the id of
     * a row in an invoice's subcollection. The two are checked against each
     * other's guard here, and the wrong one must fail.
     */
    @Test
    fun `an invoice-payment key is not a payment key, however alike they read`() {
        val ipay = mintInvoicePaymentIdempotencyKey(nowMs, seeded())
        assertTrue(ipay.matches(serverGuard("ipay")))
        assertFalse("an ipay_ key must not satisfy the pay_ guard", ipay.matches(serverGuard("pay")))
    }

    @Test
    fun `the clock goes on the wire, so two submissions in one millisecond still differ`() {
        // Same millisecond, different draws: the suffix is what separates them.
        val shared = Random(1)
        val first = mintPaymentIdempotencyKey(nowMs, shared)
        val second = mintPaymentIdempotencyKey(nowMs, shared)
        assertNotEquals(first, second)
        assertEquals(nowMs.toString(), first.split("_")[1])
        assertEquals(nowMs.toString(), second.split("_")[1])
    }

    /**
     * Deterministic given the same clock and the same seed. Not a property
     * anything relies on, but it is what makes the assertions above stable, and
     * it proves the suffix is drawn from [random] rather than from a global the
     * caller cannot control.
     */
    @Test
    fun `minting is a pure function of the clock and the injected rng`() {
        assertEquals(
            mintInvoiceIdempotencyKey(nowMs, Random(42)),
            mintInvoiceIdempotencyKey(nowMs, Random(42)),
        )
    }
}
