@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.tribe

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #1454 (operator ruling on #1295): "On Android/mobile web, the edit option
 * should only be under the account icon." The Tribe hub used to draw an Edit
 * Tribe Profile ghost button under its header at every width; it is gone, and
 * the account menu's entry (ShellNavTest pins it at slot two) is the way in.
 * The Home Information card keeps its own "Edit" link, which is that card's,
 * not one of the two entries the operator counted.
 */
class TribeHubScreenTest {

    private fun FakeFunctionsClient.stubHub() {
        stub("getMyKin", buildJsonObject {
            put("kin", buildJsonArray { add(buildJsonObject { put("id", "k1"); put("name", "Buddy"); put("status", "active") }) })
        })
        stub("getMyKinTales", buildJsonObject {
            put("hasMore", false)
            put("tales", buildJsonArray {})
        })
        stub("getMyTribeProfile", buildJsonObject {
            put("profile", buildJsonObject {
                put("kinfolkId", "3")
                put("displayName", "The Foster")
                put("customFields", buildJsonArray {})
            })
            put("homeAccess", buildJsonObject {
                put("gateCode", "1234")
                put("keyLocation", JsonNull)
                put("wifiPassword", JsonNull)
                put("customFields", buildJsonArray {})
                put("updatedAtMs", JsonNull)
            })
        })
    }

    @Test
    fun hub_hasNoEditTribeProfileButton() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubHub()
        setThemedContent {
            TribeHubScreen(
                familyName = "The Foster",
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onEditProfile = {},
                onOpenKinDetail = {},
                onManageKin = {},
                onOpenKinTales = {},
                onOpenGallery = {},
            )
        }
        waitForIdle()
        onNodeWithText("Your Kin").assertIsDisplayed()
        onAllNodesWithText("Edit Tribe Profile").assertCountEquals(0)
    }

    @Test
    fun homeInformationCard_keepsItsOwnEditLink() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubHub()
        var edits = 0
        setThemedContent {
            TribeHubScreen(
                familyName = "The Foster",
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onEditProfile = { edits += 1 },
                onOpenKinDetail = {},
                onManageKin = {},
                onOpenKinTales = {},
                onOpenGallery = {},
            )
        }
        waitForIdle()
        onNodeWithText("Home Information").performScrollTo().assertIsDisplayed()
        onNodeWithText("Gate / door code on file", substring = true).performScrollTo().assertIsDisplayed()
        // The card's "Edit" is the only edit control left on the page.
        onAllNodesWithText("Edit").assertCountEquals(1)
        onNodeWithText("Edit").performScrollTo().performClick()
        waitForIdle()
        assertEquals(1, edits, "Home Information's Edit opens the Tribe Profile editor")
    }
}
