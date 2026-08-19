package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FakeFunctionsClient
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Card management on the portal Android app (#399 item 3).
 *
 * Before this, the Billing Details card on AccountSettingsScreen said "Card
 * payments are coming soon" and had no control at all, so a kinfolk could never
 * put a card on file from the phone.
 */
class BillingPortalApiTest {

    private fun cardResponse(brand: String = "visa", last4: String = "4242") = buildJsonObject {
        put("hasPaymentMethod", true)
        put("updatedAtMs", 1_700_000_000_000L)
        put(
            "card",
            buildJsonObject {
                put("brand", brand)
                put("last4", last4)
                put("expMonth", 4)
                put("expYear", 2030)
            },
        )
    }

    @Test
    fun `getMyPaymentMethod decodes the card on file`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyPaymentMethod", cardResponse())
        val state = PortalApi(fake).getMyPaymentMethod("fam-1")

        assertTrue(state.hasPaymentMethod)
        assertEquals("visa", state.card?.brand)
        assertEquals("4242", state.card?.last4)
        assertEquals(1_700_000_000_000L, state.updatedAtMs)
        val (name, payload) = fake.calls.single()
        assertEquals("getMyPaymentMethod", name)
        assertEquals("fam-1", payload?.get("kinfolkId")?.toString()?.trim('"'))
    }

    @Test
    fun `getMyPaymentMethod reports no card without inventing one`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub(
            "getMyPaymentMethod",
            buildJsonObject { put("hasPaymentMethod", false) },
        )
        val state = PortalApi(fake).getMyPaymentMethod()

        assertFalse(state.hasPaymentMethod)
        assertNull(state.card)
        assertNull(state.updatedAtMs)
    }

    @Test
    fun `a half-written card decodes as no card rather than as blanks`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub(
            "getMyPaymentMethod",
            buildJsonObject {
                put("hasPaymentMethod", true)
                put("card", buildJsonObject { put("brand", "visa") })
            },
        )
        val state = PortalApi(fake).getMyPaymentMethod()

        assertTrue(state.hasPaymentMethod)
        assertNull(state.card)
    }

    @Test
    fun `saved card renders brand last4 and expiry`() {
        val card = SavedCard(brand = "visa", last4 = "4242", expMonth = 4, expYear = 2030)
        assertEquals("Visa •••• 4242 · exp 04/2030", card.display())
    }

    @Test
    fun `createBillingSetupSession forwards both URLs and returns the checkout link`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub(
            "createBillingSetupSession",
            buildJsonObject {
                put("checkoutUrl", "https://checkout.stripe.com/setup")
                put("sessionId", "cs_setup_1")
            },
        )
        val res = PortalApi(fake).createBillingSetupSession(
            successUrl = "https://kinfolk.tribetails.com/account?billing=saved",
            cancelUrl = "https://kinfolk.tribetails.com/account",
        )

        assertEquals("https://checkout.stripe.com/setup", res.checkoutUrl)
        assertEquals("cs_setup_1", res.sessionId)
        val (name, payload) = fake.calls.single()
        assertEquals("createBillingSetupSession", name)
        assertTrue(payload?.get("successUrl").toString().contains("billing=saved"))
        assertFalse(payload?.get("cancelUrl").toString().contains("billing=saved"))
    }

    @Test
    fun `syncMyPaymentMethod decodes the refreshed card`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("syncMyPaymentMethod", cardResponse(brand = "mastercard", last4 = "5556"))
        val state = PortalApi(fake).syncMyPaymentMethod()

        assertTrue(state.hasPaymentMethod)
        assertEquals("Mastercard •••• 5556 · exp 04/2030", state.card?.display())
    }

    @Test
    fun `removeMyPaymentMethod reports whether there was anything to remove`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("removeMyPaymentMethod", buildJsonObject { put("ok", true); put("alreadyEmpty", true) })
        assertTrue(PortalApi(fake).removeMyPaymentMethod())

        val second = FakeFunctionsClient()
        second.stub("removeMyPaymentMethod", buildJsonObject { put("ok", true); put("alreadyEmpty", false) })
        assertFalse(PortalApi(second).removeMyPaymentMethod("fam-1"))
    }

    @Test
    fun `a permission refusal surfaces rather than reading as an empty card`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyPaymentMethod", IllegalStateException("permission-denied"))
        assertFailsWith<IllegalStateException> { PortalApi(fake).getMyPaymentMethod() }
    }
}
