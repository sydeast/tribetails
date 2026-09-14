@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.tribe

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertTrue

class TribeScreenTest {

    /** #829: the Emergency Contacts card reads through its own callable. */
    private fun FakeFunctionsClient.stubEmergencyContacts(canEdit: Boolean = true, withRae: Boolean = false) {
        stub("listEmergencyContacts", buildJsonObject {
            put("contacts", buildJsonArray {
                if (withRae) add(buildJsonObject {
                    put("name", "Rae Mercer"); put("phone", "+18055550199"); put("relationship", JsonNull)
                    put("recordedAt", JsonNull); put("updatedAt", JsonNull)
                })
            })
            put("canEdit", canEdit); put("legacy", false)
        })
    }

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
        fake.stubEmergencyContacts()
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
        fake.stubEmergencyContacts()
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
        fake.stubEmergencyContacts()
        setThemedContent { TribeScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        // Save is gated on a display name; the gate explains itself inline.
        onNodeWithText("Add a display name to save.").assertIsDisplayed()
    }

    @Test
    fun afterHoursVet_alwaysVisible() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubProfileWithSavedField()
        fake.stubEmergencyContacts()
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

    /**
     * A profile as `getMyTribeProfile` serves it to an ACTIVE member after #829:
     * slot 1 still rides along as the legacy `emergencyContact*` rows, for old
     * clients. This client must neither show nor resend them.
     */
    private fun FakeFunctionsClient.stubProfileWithLegacyEmergencyRows() {
        stub("getMyTribeProfile", buildJsonObject {
            put("profile", buildJsonObject {
                put("kinfolkId", "3")
                put("displayName", "The Foster")
                put("customFields", buildJsonArray {
                    add(buildJsonObject { put("key", "emergencyContactName"); put("label", "Emergency Contact"); put("value", "Rae Halbrook") })
                    add(buildJsonObject { put("key", "emergencyContactPhone"); put("label", "Emergency Contact Phone"); put("value", "805-555-0142") })
                    add(buildJsonObject { put("key", "emergencyContactRelation"); put("label", "Emergency Contact Relation"); put("value", "Neighbor") })
                    add(buildJsonObject { put("key", "k1"); put("label", "Anniversary"); put("value", "Oct 14") })
                })
            })
            put("homeAccess", buildJsonObject {
                put("gateCode", JsonNull)
                put("keyLocation", JsonNull)
                put("wifiPassword", JsonNull)
                put("customFields", buildJsonArray {})
                put("updatedAtMs", JsonNull)
            })
            put("canEditHomeDetails", false)
        })
    }

    // #829 / #844: the lock now comes from listEmergencyContacts.canEdit, and the
    // list is read-only with the sentence saying who can change it.
    @Test
    fun emergencyContacts_readOnlyWithoutHomeAccess() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubProfileWithLegacyEmergencyRows()
        fake.stubEmergencyContacts(canEdit = false, withRae = true)
        setThemedContent { TribeScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Only someone with Home access can change the Emergency Contact.").performScrollTo().assertIsDisplayed()
        onNodeWithText("Rae Mercer").performScrollTo().assertIsDisplayed()
        assertTrue(onAllNodesWithTag("ec-0-name").fetchSemanticsNodes().isEmpty())
        assertTrue(onAllNodesWithText("Save Emergency Contacts").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun emergencyContacts_editableWithHomeAccess() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubProfileWithLegacyEmergencyRows()
        fake.stubEmergencyContacts(canEdit = true, withRae = true)
        setThemedContent { TribeScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Only someone with Home access can change the Emergency Contact.").assertDoesNotExist()
        onNodeWithTag("ec-0-name").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun theLegacyEmergencyRowsAreNeverShown() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubProfileWithLegacyEmergencyRows()
        fake.stubEmergencyContacts(canEdit = true, withRae = true)
        setThemedContent { TribeScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Oct 14").assertIsDisplayed()
        assertTrue(onAllNodesWithText("Rae Halbrook", substring = true).fetchSemanticsNodes().isEmpty())
        assertTrue(onAllNodesWithText("805-555-0142", substring = true).fetchSemanticsNodes().isEmpty())
        assertTrue(onAllNodesWithText("Emergency Contact Relation").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun theHomeAccessTogglesNameEmergencyContacts() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubProfileWithSavedField()
        fake.stubEmergencyContacts()
        fake.stub("getVetClinics", buildJsonObject { put("clinics", buildJsonArray {}) })
        fake.stub("listMembers", buildJsonObject { put("members", buildJsonArray {}) })
        fake.stub("listHouseholdContacts", buildJsonObject { put("contacts", buildJsonArray {}) })
        setThemedContent { TribeScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Home access (gate code, Wi-Fi, Emergency Contacts)").performScrollTo().assertIsDisplayed()
        assertTrue(onAllNodesWithText("Home access (gate code, Wi-Fi)").fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun theProfileSaveCarriesNoEmergencyContactKey() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubProfileWithLegacyEmergencyRows()
        fake.stubEmergencyContacts(canEdit = true, withRae = true)
        fake.stub("getVetClinics", buildJsonObject { put("clinics", buildJsonArray {}) })
        fake.stub("listMembers", buildJsonObject { put("members", buildJsonArray {}) })
        fake.stub("listHouseholdContacts", buildJsonObject { put("contacts", buildJsonArray {}) })
        fake.stub("saveTribeProfile", buildJsonObject { put("ok", true) })
        fake.stub("saveHomeAccess", buildJsonObject { put("ok", true) })
        setThemedContent { TribeScreen("X", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Save Changes").performScrollTo().performClick()
        waitForIdle()
        val keys = fake.calls.last { it.first == "saveTribeProfile" }.second!!["customFields"]!!.jsonArray.map { it.jsonObject["key"]!!.jsonPrimitive.content }
        assertTrue(keys.none { it.startsWith("emergencyContact") }, "sent $keys")
        assertTrue("k1" in keys, "the unrelated field still rides along: $keys")
        assertTrue(fake.calls.none { it.first == "saveEmergencyContacts" })
        onNodeWithText("Saved.").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun unsavedEmergencyContactsAreNamedAtThePageSave() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubProfileWithSavedField()
        fake.stubEmergencyContacts(canEdit = true, withRae = true)
        fake.stub("getVetClinics", buildJsonObject { put("clinics", buildJsonArray {}) })
        fake.stub("listMembers", buildJsonObject { put("members", buildJsonArray {}) })
        fake.stub("listHouseholdContacts", buildJsonObject { put("contacts", buildJsonArray {}) })
        fake.stub("saveTribeProfile", buildJsonObject { put("ok", true) })
        fake.stub("saveHomeAccess", buildJsonObject { put("ok", true) })
        setThemedContent { TribeScreen("X", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Your Emergency Contacts have unsaved changes.").assertDoesNotExist()
        onNodeWithTag("ec-0-name").performScrollTo().performTextInput(" Jr")
        waitForIdle()
        onNodeWithText("Your Emergency Contacts have unsaved changes.").performScrollTo().assertIsDisplayed()
        onNodeWithText("Save Changes").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Profile saved. Your Emergency Contacts are not saved yet: use Save Emergency Contacts.")
            .performScrollTo().assertIsDisplayed()
        assertTrue(fake.calls.none { it.first == "saveEmergencyContacts" })
        onNodeWithText("Unsaved changes").performScrollTo().assertIsDisplayed()
    }
}
