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
 * SECOND one that stays payable alongside the first. Since #826 a second
 * completed session no longer pays the bill twice: the webhook recognises it
 * and routes the money to the household's account balance. That net cannot
 * un-charge the card, and by standing ruling there is no refund, so the second
 * SESSION is still the thing worth preventing, and the key is what prevents it.
 * It works by being handed on to Stripe, so what this client has to get right
 * is putting it on the wire when it has one and leaving the payload untouched
 * when it does not.
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
