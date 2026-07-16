@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.schedule

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test

class BookingWizardTest {

    private fun stubKinAndServices(fake: FakeFunctionsClient) {
        fake.stub("getMyKin", buildJsonObject {
            put("kin", buildJsonArray {
                add(buildJsonObject {
                    put("id", "k1"); put("name", "Buddy"); put("status", "active")
                })
                add(buildJsonObject {
                    put("id", "k2"); put("name", "Willow"); put("status", "active")
                })
            })
        })
        fake.stub("getServiceCatalog", buildJsonObject {
            put("services", buildJsonArray {
                add(buildJsonObject {
                    put("id", "s1"); put("name", "Auntie's In")
                    put("category", "Held Down at Home"); put("priceMinCents", 1500L); put("priceMaxCents", 8000L)
                })
                add(buildJsonObject {
                    put("id", "s2"); put("name", "Overnight Stays")
                    put("category", "Held Down at Home"); put("priceCents", 15000L); put("isOvernight", true)
                })
            })
        })
    }

    @Test
    fun step1_defaultsToAllKinAndAllowsAdvance() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubKinAndServices(fake)
        setThemedContent {
            BookingWizardScreen(
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onClose = {},
                onComplete = {},
            )
        }
        waitForIdle()
        onNodeWithText("All Kin in this home").assertIsDisplayed()
        onNodeWithText("Next").assertIsEnabled()
    }

    @Test
    fun step1_chooseSpecificRequiresSelection() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubKinAndServices(fake)
        setThemedContent {
            BookingWizardScreen(
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onClose = {},
                onComplete = {},
            )
        }
        waitForIdle()
        onNodeWithText("Choose specific Kin").performClick()
        waitForIdle()
        onNodeWithText("Next").assertIsNotEnabled()
        onNodeWithText("Buddy").performClick()
        waitForIdle()
        onNodeWithText("Next").assertIsEnabled()
    }

    @Test
    fun step2_listsServicesAndAdvances() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubKinAndServices(fake)
        setThemedContent {
            BookingWizardScreen(
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onClose = {},
                onComplete = {},
            )
        }
        waitForIdle()
        // Step 1 default = all kin → Next enabled immediately.
        onNodeWithText("Next").performClick()
        waitForIdle()
        onNodeWithText("Choose Service").assertIsDisplayed()
        onNodeWithText("Auntie's In").assertIsDisplayed()
        onNodeWithText("Overnight Stays").assertIsDisplayed()
        onNodeWithText("Next").assertIsNotEnabled()
        onNodeWithText("Auntie's In").performClick()
        waitForIdle()
        onNodeWithText("Next").assertIsEnabled()
    }

    @Test
    fun step3_dateAndTimeRequiredBeforeNext() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubKinAndServices(fake)
        setThemedContent {
            BookingWizardScreen(
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onClose = {},
                onComplete = {},
            )
        }
        waitForIdle()
        onNodeWithText("Next").performClick()
        waitForIdle()
        onNodeWithText("Auntie's In").performClick()
        onNodeWithText("Next").performClick()
        waitForIdle()
        onNodeWithText("Schedule Dates").assertIsDisplayed()
        onNodeWithText("Next").assertIsNotEnabled()
    }

    @Test
    fun cancel_callsOnClose() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stubKinAndServices(fake)
        var closed = false
        setThemedContent {
            BookingWizardScreen(
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onClose = { closed = true },
                onComplete = {},
            )
        }
        waitForIdle()
        onNodeWithText("Cancel").performClick()
        waitForIdle()
        kotlin.test.assertTrue(closed, "onClose should fire from Cancel button")
    }
}
