@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.home

import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test

/**
 * #1005: a member without billing access gets no "View invoices" on Home.
 * `AppNavHost` passes `onOpenInvoices = null` for them.
 */
class HomeScreenBillingAccessTest {

    private fun stubEmptyHome(fake: FakeFunctionsClient) {
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {})
            put("recent", buildJsonArray {})
        })
    }

    @Test
    fun noBillingAccess_hidesViewInvoices() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubEmptyHome(fake)
        setThemedContent { HomeScreen("The Foster", "demo-1", PortalApi(fake), onOpenInvoices = null) }
        waitForIdle()
        onNodeWithText("Book a visit").assertExists()
        onNodeWithText("View invoices").assertDoesNotExist()
    }

    @Test
    fun billingAccess_keepsViewInvoices() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubEmptyHome(fake)
        setThemedContent { HomeScreen("The Foster", "demo-1", PortalApi(fake), onOpenInvoices = {}) }
        waitForIdle()
        onNodeWithText("View invoices").assertExists()
    }
}
