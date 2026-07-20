@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.kintales

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

class KinTalesScreenTest {

    @Test
    fun empty_rendersEmptyState() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinTales", buildJsonObject {
            put("tales", buildJsonArray {})
            put("hasMore", false)
        })
        setThemedContent { KinTalesScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("No KinTales yet").assertIsDisplayed()
        onNodeWithText("All").assertIsDisplayed()
        onNodeWithText("Notes").assertIsDisplayed()
        onNodeWithText("Gallery").assertIsDisplayed()
    }

    @Test
    fun talesRender_authorBodyAndPhotoBadge() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinTales", buildJsonObject {
            put("hasMore", false)
            put("tales", buildJsonArray {
                add(buildJsonObject {
                    put("id", "t1")
                    put("body", "Kai played fetch today.")
                    put("authorDisplayName", "Auntie Avery")
                    put("mediaIds", buildJsonArray { add("m1"); add("m2") })
                    put("sentAtMs", 1_700_000_000_000L)
                    put("shared", false)
                })
            })
        })
        setThemedContent { KinTalesScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Auntie Avery").assertIsDisplayed()
        onNodeWithText("Kai played fetch today.").assertIsDisplayed()
        // The badge renders "2 photos · view" (count plus an expand affordance).
        onNodeWithText("2 photos", substring = true).assertIsDisplayed()
    }

    @Test
    fun galleryFilter_hidesTextOnlyTales() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKinTales", buildJsonObject {
            put("hasMore", false)
            put("tales", buildJsonArray {
                add(buildJsonObject {
                    put("id", "t-text")
                    put("body", "Just a story.")
                    put("authorDisplayName", "Auntie")
                    put("mediaIds", buildJsonArray {})
                    put("shared", false)
                })
            })
        })
        setThemedContent { KinTalesScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Just a story.").assertIsDisplayed()
        onNodeWithText("Gallery").performClick()
        waitForIdle()
        onNodeWithText("Nothing in Gallery yet").assertIsDisplayed()
    }

    @Test
    fun error_rendersFailureCard() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyKinTales", IllegalStateException("server-down"))
        setThemedContent { KinTalesScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Couldn't load KinTales").assertIsDisplayed()
    }
}
