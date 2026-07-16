@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.home

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Message Auntie (16.4) - Home entry point. The header is now a hero (no chip);
 * Message Auntie lives as the Quick Start "Message your Auntie" button in the aside.
 */
class HomeScreenMessageAuntieTest {

    private fun stubEmptyHome(fake: FakeFunctionsClient) {
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {})
            put("recent", buildJsonArray {})
        })
    }

    @Test
    fun quickStartButton_visibleAndNavigates() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubEmptyHome(fake)
        var opened = false
        setThemedContent {
            HomeScreen("The Foster", "demo-1", PortalApi(fake), onMessageAuntie = { opened = true })
        }
        waitForIdle()
        onNodeWithText("Message your Auntie").assertIsDisplayed()
        onNodeWithText("Message your Auntie").performClick()
        waitForIdle()
        assertTrue(opened, "Quick Start \"Message your Auntie\" button should fire onMessageAuntie")
    }
}
