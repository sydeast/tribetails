@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.home

import androidx.compose.ui.test.assertIsDisplayed
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

class HomeScreenTest {

    @Test
    fun emptyState_rendersBothEmptySections() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", kotlinx.serialization.json.JsonNull)
            put("upcoming", buildJsonArray {})
            put("recent", buildJsonArray {})
        })
        setThemedContent {
            HomeScreen("The Foster", "demo-1", PortalApi(fake))
        }
        waitForIdle()
        // Hero header (no longer the family name).
        onNodeWithText("Your tribe is in good hands.").assertIsDisplayed()
        // The two sections driven by the stubbed-empty bookings data.
        onNodeWithText("No active visit").assertIsDisplayed()
        onNodeWithText("Nothing scheduled").assertIsDisplayed()
    }

    @Test
    fun liveVisit_rendersLivePillAndAuntieName() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", buildJsonObject {
                put("id", "b1")
                put("kinfolkId", "demo-1")
                put("status", "active")
                put("serviceType", "Walk")
                put("auntieDisplayName", "Auntie Avery")
                put("kinNames", buildJsonArray { add("Buddy") })
                put("visitProgress", "active")
            })
            put("upcoming", buildJsonArray {})
            put("recent", buildJsonArray {})
        })
        setThemedContent {
            HomeScreen("The Foster", "demo-1", PortalApi(fake))
        }
        waitForIdle()
        onNodeWithText("Auntie Avery").assertIsDisplayed()
        onNodeWithText("LIVE").assertIsDisplayed()
        onNodeWithText("With Buddy").assertIsDisplayed()
    }

    @Test
    fun talesFailure_offersRetryThatRecovers() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", kotlinx.serialization.json.JsonNull)
            put("upcoming", buildJsonArray {})
            put("recent", buildJsonArray {})
        })
        fake.stubError("getMyKinTales", IllegalStateException("tales down"))
        setThemedContent {
            HomeScreen("The Foster", "demo-1", PortalApi(fake))
        }
        waitForIdle()
        // Failed widget is not a blank card: it names the problem and offers Retry.
        onNodeWithText("KinTales unavailable").assertIsDisplayed()
        onNodeWithText("Retry").assertIsDisplayed()
        // Server recovers; Retry refetches and the tale renders.
        fake.stub("getMyKinTales", buildJsonObject {
            put("hasMore", false)
            put("tales", buildJsonArray {
                add(buildJsonObject {
                    put("id", "t1")
                    put("body", "Buddy chased the ball all afternoon.")
                    put("authorDisplayName", "Auntie Avery")
                    put("mediaIds", buildJsonArray {})
                    put("shared", false)
                })
            })
        })
        onNodeWithText("Retry").performClick()
        waitForIdle()
        onNodeWithText("Buddy chased the ball all afternoon.").assertIsDisplayed()
        onNodeWithText("KinTales unavailable").assertDoesNotExist()
    }

    @Test
    fun error_rendersFailureCard() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyBookings", IllegalStateException("network down"))
        setThemedContent {
            HomeScreen("The Foster", "demo-1", PortalApi(fake))
        }
        waitForIdle()
        onNodeWithText("Couldn't load Home").assertIsDisplayed()
        onNodeWithText("network down").assertIsDisplayed()
    }
}
