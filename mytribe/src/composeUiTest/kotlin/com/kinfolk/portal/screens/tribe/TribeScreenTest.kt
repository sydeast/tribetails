@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.tribe

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
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

class TribeScreenTest {

    @Test
    fun loadsProfileAndHomeAccess() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyTribeProfile", buildJsonObject {
            put("profile", buildJsonObject {
                put("kinfolkId", "3")
                put("displayName", "The Foster")
                put("customFields", buildJsonArray {})
            })
            put("homeAccess", buildJsonObject {
                put("gateCode", "1234")
                put("keyLocation", "Under frog statue")
                put("wifiPassword", "TribeNet_5G")
                put("customFields", buildJsonArray {})
                put("updatedAtMs", JsonNull)
            })
        })
        setThemedContent { TribeScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Tribe Profile").assertIsDisplayed()
        onNodeWithText("Home Information").assertIsDisplayed()
        onNodeWithText("Family Display Name").assertIsDisplayed()
        // Save sits at the bottom of a tall scrollable settings form.
        onNodeWithText("Save Changes").performScrollTo().assertIsDisplayed()
    }

    private fun FakeFunctionsClient.stubProfileWithSavedField() {
        stub("getMyTribeProfile", buildJsonObject {
            put("profile", buildJsonObject {
                put("kinfolkId", "3")
                put("displayName", "X")
                put("customFields", buildJsonArray {
                    add(buildJsonObject {
                        put("key", "k1")
                        put("label", "Anniversary")
                        put("value", "Oct 14")
                    })
                })
            })
            put("homeAccess", buildJsonObject {
                put("gateCode", JsonNull)
                put("keyLocation", JsonNull)
                put("wifiPassword", JsonNull)
                put("customFields", buildJsonArray {})
                put("updatedAtMs", JsonNull)
            })
        })
    }

    @Test
    fun customFields_readOnlyDisplay_noAddControls() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubProfileWithSavedField()
        setThemedContent { TribeScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        // Saved field still shows read-only (no data is hidden).
        onNodeWithText("Anniversary").assertIsDisplayed()
        onNodeWithText("Oct 14").assertIsDisplayed()
        // Read-only fields say who owns them instead of looking broken.
        onNodeWithText("Set by your Auntie. Ask them to update these.").assertIsDisplayed()
        // The legacy add-field editor was removed: a kinfolk can never add fields.
        onNodeWithText("Add Profile Field").assertDoesNotExist()
        onNodeWithText("Add Home Field").assertDoesNotExist()
    }

    @Test
    fun blankDisplayName_showsSaveHelper() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyTribeProfile", buildJsonObject {
            put("profile", buildJsonObject {
                put("kinfolkId", "3")
                put("displayName", "")
                put("customFields", buildJsonArray {})
            })
            put("homeAccess", buildJsonObject {
                put("gateCode", JsonNull)
                put("keyLocation", JsonNull)
                put("wifiPassword", JsonNull)
                put("customFields", buildJsonArray {})
                put("updatedAtMs", JsonNull)
            })
        })
        setThemedContent { TribeScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        // Save is gated on a display name; the gate explains itself inline.
        onNodeWithText("Add a display name to save.").assertIsDisplayed()
    }

    @Test
    fun afterHoursVet_alwaysVisible() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubProfileWithSavedField()
        setThemedContent { TribeScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        // The after-hours block lives inside the vet clinic card, below the fold.
        onNodeWithText("After-hours").performScrollTo().assertIsDisplayed()
        onNodeWithText("Emergency Clinic").performScrollTo().assertIsDisplayed()
        onNodeWithText("Emergency Clinic Phone").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun error_rendersErrorMessage() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyTribeProfile", IllegalStateException("read failed"))
        setThemedContent { TribeScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("read failed").assertIsDisplayed()
    }
}
