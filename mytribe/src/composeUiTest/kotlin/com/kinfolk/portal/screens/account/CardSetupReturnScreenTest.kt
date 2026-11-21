@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.account

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #2427: Account Settings sends Stripe an address this app claims, and a
 * return from Stripe's card page reads the card again from Stripe.
 */
class CardSetupReturnScreenTest {

    private fun stub(fake: FakeFunctionsClient) {
        fake.stub("getMyAccount", buildJsonObject {
            put("uid", "u1")
            put("email", "catch@hanasamku.com")
            put("displayName", "Sydney")
            put("phone", JsonNull)
            put("backupEmail", JsonNull)
            put("backupPhone", JsonNull)
            put("kinfolkIds", buildJsonArray {})
            put("hasPaymentMethod", false)
            put("updatedAtMs", JsonNull)
        })
        // The stored copy, from before the card was saved.
        fake.stub("getMyPaymentMethod", buildJsonObject { put("hasPaymentMethod", false) })
        // What Stripe says now.
        fake.stub("syncMyPaymentMethod", buildJsonObject {
            put("hasPaymentMethod", true)
            put("card", buildJsonObject {
                put("brand", "visa")
                put("last4", "4242")
            })
        })
    }

    @Test
    fun aReturnFromStripe_readsTheCardFromStripe_andTheStoredCopyDoesNotLandOnTop() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stub(fake)
        var seen = 0
        setThemedContent {
            AccountSettingsScreen(
                "The Foster",
                PortalApi(fake),
                cardSetupReturn = CardSetupReturn(saved = true),
                onCardSetupReturnSeen = { seen++ },
            )
        }
        waitForIdle()
        assertTrue(fake.calls.any { it.first == "syncMyPaymentMethod" }, "the card must be read from Stripe")
        assertEquals(1, seen)
        onNodeWithText("Card on file.").performScrollTo().assertIsDisplayed()
        onNodeWithText("Payment method on file").performScrollTo().assertIsDisplayed()
        onNodeWithText("No payment method on file").assertDoesNotExist()
    }

    @Test
    fun noReturn_readsOnlyTheStoredCard() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stub(fake)
        setThemedContent { AccountSettingsScreen("The Foster", PortalApi(fake)) }
        waitForIdle()
        assertFalse(fake.calls.any { it.first == "syncMyPaymentMethod" })
        onNodeWithText("No payment method on file").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun withoutBillingAccess_aReturnReadsNothing() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stub(fake)
        setThemedContent {
            AccountSettingsScreen(
                "The Foster",
                PortalApi(fake),
                billingAccess = false,
                cardSetupReturn = CardSetupReturn(saved = true),
            )
        }
        waitForIdle()
        assertFalse(fake.calls.any { it.first == "syncMyPaymentMethod" })
        assertFalse(fake.calls.any { it.first == "getMyPaymentMethod" })
    }

    @Test
    fun addACard_sendsStripeTheAddressesThisAppClaims() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stub(fake)
        fake.stub("createBillingSetupSession", buildJsonObject {
            put("checkoutUrl", "https://checkout.stripe.com/c/setup/cs_1")
            put("sessionId", "cs_1")
        })
        val opened = mutableListOf<String>()
        setThemedContent { AccountSettingsScreen("The Foster", PortalApi(fake), openUrl = { opened += it }) }
        waitForIdle()
        onNodeWithText("Add a card").performScrollTo().performClick()
        waitForIdle()
        val payload = fake.calls.last { it.first == "createBillingSetupSession" }.second!!
        assertEquals("https://kinfolk.tribetails.com/app/account?billing=saved", payload["successUrl"]!!.jsonPrimitive.content)
        assertEquals("https://kinfolk.tribetails.com/app/account", payload["cancelUrl"]!!.jsonPrimitive.content)
        assertEquals(listOf("https://checkout.stripe.com/c/setup/cs_1"), opened)
    }
}
