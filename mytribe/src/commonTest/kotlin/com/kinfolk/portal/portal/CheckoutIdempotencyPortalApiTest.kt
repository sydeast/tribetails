package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

/**
 * #825, the portal app's half.
 *
 * `payInvoice` asks STRIPE to open a Checkout Session, and a replay opens a
 * SECOND one that stays payable alongside the first. Two sessions become two
 * PaymentIntents, `stripeWebhook` claims on the PaymentIntent id, so both
 * settle and the household is charged twice for one bill — with no refund
 * available to put it back, by standing ruling. The key is the only thing that
 * stops it, and it works by being handed on to Stripe, so what this client has
 * to get right is putting it on the wire when it has one and leaving the
 * payload untouched when it does not.
 *
 * This client does not retry on its own: `FunctionsClient.call` throws a plain
 * `Throwable` with no code, so it cannot tell a dropped request from a refusal.
 * The retry here is the household tapping Pay again, which is exactly what the
 * key protects.
 */
class CheckoutIdempotencyPortalApiTest {

    private val KEY = "chk_1757700000000_a1b2c3"

    private fun stubbedClient(): FakeFunctionsClient {
        val fake = FakeFunctionsClient()
        fake.stub(
            "payInvoice",
            buildJsonObject {
                put("checkoutUrl", "https://checkout.stripe.com/c/pay/cs_test_1")
                put("sessionId", "cs_test_1")
                put("amountCents", 4000)
                put("currency", "usd")
            },
        )
        return fake
    }

    @Test
    fun sendsTheKeyWhenTheCallerSuppliesOne() = runTest {
        val fake = stubbedClient()
        PortalApi(fake).payInvoice(
            invoiceId = "inv1",
            kinfolkId = "kf1",
            successUrl = "https://example.test/ok",
            cancelUrl = "https://example.test/no",
            idempotencyKey = KEY,
        )
        assertEquals(KEY, fake.calls.single().second!!["idempotencyKey"]!!.jsonPrimitive.content)
    }

    @Test
    fun omitsTheKeyEntirelyWhenTheCallerHasNone() = runTest {
        // OMITTED, NOT NULL. The server's zod arg is `.optional()` and not
        // `.nullable()`, because Kotlin's one `T?` cannot distinguish "key
        // omitted" from "key sent null" — see the ADR-0003 note the booking
        // callables carry. A null on the wire would be refused outright.
        val fake = stubbedClient()
        PortalApi(fake).payInvoice(
            invoiceId = "inv1",
            kinfolkId = "kf1",
            successUrl = "https://example.test/ok",
            cancelUrl = "https://example.test/no",
        )
        assertFalse(fake.calls.single().second!!.containsKey("idempotencyKey"))
    }

    @Test
    fun mintsTheShapeTheServerAccepts() {
        val key = mintCheckoutIdempotencyKey(Random(7))
        assertTrue(
            Regex("^chk_[0-9]{10,16}_[a-z0-9]{1,16}$").matches(key),
            "minted key was '$key', which the callable's zod guard would refuse",
        )
    }

    @Test
    fun mintsADifferentKeyEachTime() {
        // The HOLDING of a key is the controller's job; the minter's job is to
        // never hand out the same one twice, or two genuinely separate payments
        // would collapse into one.
        assertNotEquals(mintCheckoutIdempotencyKey(Random(1)), mintCheckoutIdempotencyKey(Random(2)))
    }
}
