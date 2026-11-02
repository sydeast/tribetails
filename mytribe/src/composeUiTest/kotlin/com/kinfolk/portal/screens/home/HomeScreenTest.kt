@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.home

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.width
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertTrue

class HomeScreenTest {

    /**
     * #1412: Home is the dashboard. The kin roster is Tribe's, so Home never
     * calls getMyKin and never draws "Your tribe" or "Add Kin". No getMyKin
     * stub here on purpose: a call would be recorded and fail the assertion.
     */
    @Test
    fun home_neverLoadsOrDrawsTheKinRoster() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", kotlinx.serialization.json.JsonNull)
            put("upcoming", buildJsonArray {})
            put("recent", buildJsonArray {})
        })
        fake.stub("getMyKinTales", buildJsonObject {
            put("hasMore", false)
            put("tales", buildJsonArray {})
        })
        setThemedContent {
            HomeScreen("The Foster", "demo-1", PortalApi(fake))
        }
        waitForIdle()
        assertTrue(fake.calls.none { it.first == "getMyKin" }, "Home must not call getMyKin: ${fake.calls.map { it.first }}")
        onNodeWithText("YOUR TRIBE").assertDoesNotExist()
        onNodeWithText("Add Kin").assertDoesNotExist()
        onNodeWithText("Tribe unavailable").assertDoesNotExist()
        onNodeWithText("QUICK START").assertExists()
    }

    /** #1412: on a phone, Quick Start sits above Up next, above the fold. */
    @Test
    fun narrow_quickStartIsAboveUpNext() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", kotlinx.serialization.json.JsonNull)
            put("upcoming", buildJsonArray {})
            put("recent", buildJsonArray {})
        })
        setThemedContent {
            // 390dp: a phone, well under the 880dp wide-shell breakpoint.
            Box(Modifier.width(390.dp)) {
                HomeScreen("The Foster", "demo-1", PortalApi(fake))
            }
        }
        waitForIdle()
        val quickTop = onNodeWithText("QUICK START").getBoundsInRoot().top
        val upNextTop = onNodeWithText("UP NEXT").getBoundsInRoot().top
        assertTrue(quickTop < upNextTop, "Quick Start ($quickTop) should sit above Up next ($upNextTop)")
    }

    @Test
    fun emptyState_drawsNothingForIdleVisit() = runComposeUiTest {
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
        // #1421: no live visit means no heading and no card, like web.
        onNodeWithText("No active visit").assertDoesNotExist()
        onNodeWithText("Live Visit").assertDoesNotExist()
        onNodeWithText("LIVE").assertDoesNotExist()
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
        onNodeWithText("Live Visit").assertDoesNotExist()
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

    @Test
    fun recentKinTaleCard_opensThatTale() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", kotlinx.serialization.json.JsonNull)
            put("upcoming", buildJsonArray {})
            put("recent", buildJsonArray {})
        })
        fake.stub("getMyKinTales", buildJsonObject {
            put("hasMore", false)
            put("tales", buildJsonArray {
                add(buildJsonObject {
                    put("id", "t-a")
                    put("body", "Buddy chased the ball.")
                    put("authorDisplayName", "Maya")
                    put("mediaIds", buildJsonArray {})
                    put("shared", false)
                })
                add(buildJsonObject {
                    put("id", "t-b")
                    put("body", "Buddy napped all afternoon.")
                    put("authorDisplayName", "Maya")
                    put("mediaIds", buildJsonArray {})
                    put("shared", false)
                })
            })
        })
        val opened = mutableListOf<String>()
        setThemedContent {
            HomeScreen("The Foster", "demo-1", PortalApi(fake), onOpenKinTale = { opened += it })
        }
        waitForIdle()
        onNodeWithText("Buddy napped all afternoon.").performClick()
        waitForIdle()
        kotlin.test.assertEquals(listOf("t-b"), opened)
    }
}
