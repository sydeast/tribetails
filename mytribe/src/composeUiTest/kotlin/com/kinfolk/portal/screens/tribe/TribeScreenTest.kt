@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.tribe

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.firebase.FunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
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

    // ---- #873: a schema-mode save keeps the rows it does not edit ----

    /**
     * Answers getFormSchema by schemaId, which [FakeFunctionsClient] cannot, and
     * hands every other call to [fake] so its call log still records the saves.
     */
    private class SchemaFunctions(
        private val fake: FakeFunctionsClient,
        private val schemas: Map<String, JsonObject>,
    ) : FunctionsClient {
        override suspend fun call(name: String, payload: JsonObject?): JsonObject {
            if (name == "getFormSchema") {
                val id = payload?.get("schemaId")?.jsonPrimitive?.content
                return schemas[id] ?: throw IllegalStateException("not-found")
            }
            return fake.call(name, payload)
        }
    }

    private fun schemaJson(id: String, vararg fields: Pair<String, String>) = buildJsonObject {
        put("id", id); put("name", id); put("version", 1)
        put("sections", buildJsonArray {
            add(buildJsonObject {
                put("title", "Details for $id")
                put("fields", buildJsonArray {
                    fields.forEach { (key, label) -> add(buildJsonObject { put("key", key); put("label", label); put("type", "text") }) }
                })
            })
        })
    }

    private fun row(key: String, label: String, value: String) = Triple(key, label, value)
    private val office = row("gateNote", "Set by Auntie", "Side gate sticks")
    private val allergy = row("allergy", "Allergies", "Chicken")
    private val vet = row("vetClinicId", "Vet Clinic", "clinic-1")
    private val shed = row("shed", "Set by Auntie", "Left of the gate")
    private val alarm = row("alarm", "Alarm Code", "5678")
    private val afterPhone = row("afterHoursVetPhone", "After-hours Phone", "805-555-0100")

    private fun rowsJson(vararg rows: Triple<String, String, String>) = buildJsonArray {
        rows.forEach { (k, l, v) -> add(buildJsonObject { put("key", k); put("label", l); put("value", v) }) }
    }

    private fun schemaHousehold(): Pair<FakeFunctionsClient, PortalApi> {
        val fake = FakeFunctionsClient()
        fake.stub("getMyTribeProfile", buildJsonObject {
            put("profile", buildJsonObject {
                put("kinfolkId", "3"); put("displayName", "The Foster")
                put("customFields", rowsJson(office, allergy, vet))
            })
            put("homeAccess", buildJsonObject {
                put("gateCode", "4242"); put("keyLocation", JsonNull); put("wifiPassword", JsonNull)
                put("customFields", rowsJson(shed, alarm, afterPhone))
                put("updatedAtMs", JsonNull)
            })
        })
        fake.stubEmergencyContacts()
        fake.stub("getVetClinics", buildJsonObject { put("clinics", buildJsonArray {}) })
        fake.stub("listMembers", buildJsonObject { put("members", buildJsonArray {}) })
        fake.stub("listHouseholdContacts", buildJsonObject { put("contacts", buildJsonArray {}) })
        fake.stub("saveTribeProfile", buildJsonObject { put("ok", true) })
        fake.stub("saveHomeAccess", buildJsonObject { put("ok", true) })
        val schemas = mapOf(
            "tribeProfile" to schemaJson("tribeProfile", "displayName" to "Family Display Name", "allergy" to "Allergies", "color" to "Favorite color"),
            "homeAccess" to schemaJson("homeAccess", "gateCode" to "Gate / Door Code", "alarm" to "Alarm Code", "pool" to "Pool gate"),
        )
        return fake to PortalApi(SchemaFunctions(fake, schemas))
    }

    private fun FakeFunctionsClient.sent(name: String): Pair<List<Triple<String, String, String>>, List<String>?> {
        val payload = calls.last { it.first == name }.second!!
        val rows = payload["customFields"]!!.jsonArray.map {
            val o = it.jsonObject
            Triple(o["key"]!!.jsonPrimitive.content, o["label"]!!.jsonPrimitive.content, o["value"]!!.jsonPrimitive.content)
        }
        val removed = (payload["removeCustomFieldKeys"] as? JsonArray)?.map { it.jsonPrimitive.content }
        return rows to removed
    }

    @Test
    fun schemaSave_untouched_sendsEveryStoredRowAsStored_andNoEmptyRowForAnUnstoredField() = runComposeUiTest {
        val (fake, api) = schemaHousehold()
        setThemedContent { TribeScreen("The Foster", "3", api) }
        waitForIdle()
        onNodeWithText("Chicken").performScrollTo().assertIsDisplayed()
        onNodeWithText("Save Changes").performScrollTo().performClick()
        waitForIdle()
        assertEquals(listOf(office, allergy, vet) to emptyList<String>(), fake.sent("saveTribeProfile"))
        // #868: nothing in the home details changed, so no home access call.
        assertTrue(fake.calls.none { it.first == "saveHomeAccess" }, "calls: ${fake.calls.map { it.first }}")
    }

    @Test
    fun schemaSave_clearedSchemaField_isSentAsARealClear_andNothingElseChanges() = runComposeUiTest {
        val (fake, api) = schemaHousehold()
        setThemedContent { TribeScreen("The Foster", "3", api) }
        waitForIdle()
        onNodeWithText("Chicken").performScrollTo().performTextClearance()
        onNodeWithText("5678").performScrollTo().performTextClearance()
        waitForIdle()
        onNodeWithText("Save Changes").performScrollTo().performClick()
        waitForIdle()
        assertEquals(listOf(office, allergy.copy(third = ""), vet) to emptyList<String>(), fake.sent("saveTribeProfile"))
        assertEquals(listOf(shed, alarm.copy(third = ""), afterPhone) to emptyList<String>(), fake.sent("saveHomeAccess"))
    }

    @Test
    fun schemaSave_clearedAfterHoursPhone_isRemovedByName() = runComposeUiTest {
        val (fake, api) = schemaHousehold()
        setThemedContent { TribeScreen("The Foster", "3", api) }
        waitForIdle()
        onNodeWithText("805-555-0100").performScrollTo().performTextClearance()
        waitForIdle()
        onNodeWithText("Save Changes").performScrollTo().performClick()
        waitForIdle()
        assertEquals(listOf(shed, alarm) to listOf("afterHoursVetPhone"), fake.sent("saveHomeAccess"))
        assertEquals(listOf(office, allergy, vet) to emptyList<String>(), fake.sent("saveTribeProfile"))
    }

    @Test
    fun save_refusedForTheHourlyLimit_saysSoPlainly() = runComposeUiTest {
        val (fake, api) = schemaHousehold()
        // What the native Android SDK hands back for lib/rateLimit.ts's refusal.
        fake.stubError("saveTribeProfile", IllegalStateException("Too many attempts. Try again later."))
        setThemedContent { TribeScreen("The Foster", "3", api) }
        waitForIdle()
        onNodeWithText("Save Changes").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText(PROFILE_SAVE_RATE_LIMITED_MESSAGE).performScrollTo().assertIsDisplayed()
        onNodeWithText("Saved.").assertDoesNotExist()
    }

    // ---- #868: the home details follow Home access, and a partial save says so ----

    /** A household as getMyTribeProfile serves it to a viewer with or without Home access. */
    private fun viewer(canEditHome: Boolean): FakeFunctionsClient {
        val fake = FakeFunctionsClient()
        fake.stub("getMyTribeProfile", buildJsonObject {
            put("profile", buildJsonObject {
                put("kinfolkId", "3"); put("displayName", "Foster Household"); put("customFields", buildJsonArray {})
            })
            put("homeAccess", buildJsonObject {
                // The server sends no home values without the grant (getMyTribeProfile.ts).
                if (canEditHome) put("gateCode", "4242") else put("gateCode", JsonNull)
                put("keyLocation", JsonNull); put("wifiPassword", JsonNull)
                put("customFields", if (canEditHome) rowsJson(afterPhone) else buildJsonArray {})
                put("updatedAtMs", JsonNull)
            })
            put("canEditHomeDetails", canEditHome)
        })
        fake.stubEmergencyContacts(canEdit = canEditHome)
        fake.stub("getVetClinics", buildJsonObject { put("clinics", buildJsonArray {}) })
        fake.stub("listMembers", buildJsonObject { put("members", buildJsonArray {}) })
        fake.stub("listHouseholdContacts", buildJsonObject { put("contacts", buildJsonArray {}) })
        fake.stub("saveTribeProfile", buildJsonObject { put("ok", true) })
        fake.stub("saveHomeAccess", buildJsonObject { put("ok", true) })
        return fake
    }

    private val refused = "You need Home access to change the home details. Ask your primary kinfolk to give you Home access."

    @Test
    fun primary_familyOnlyEdit_savesTheProfile_andMakesNoHomeAccessCall() = runComposeUiTest {
        val fake = viewer(canEditHome = true)
        setThemedContent { TribeScreen("Foster Household", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithTag("home-locked").assertDoesNotExist()
        onNodeWithText("Foster Household").performScrollTo().performTextReplacement("Foster Two")
        waitForIdle()
        onNodeWithText("Save Changes").performScrollTo().performClick()
        waitForIdle()
        assertEquals("Foster Two", fake.calls.last { it.first == "saveTribeProfile" }.second!!["displayName"]!!.jsonPrimitive.content)
        assertTrue(fake.calls.none { it.first == "saveHomeAccess" }, "calls: ${fake.calls.map { it.first }}")
        onNodeWithText("Saved.").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun secondaryWithHomeAccess_gateCodeEdit_goesToSaveHomeAccess() = runComposeUiTest {
        val fake = viewer(canEditHome = true)
        setThemedContent { TribeScreen("Foster Household", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("4242").performScrollTo().performTextReplacement("9001")
        waitForIdle()
        onNodeWithText("Save Changes").performScrollTo().performClick()
        waitForIdle()
        val home = fake.calls.last { it.first == "saveHomeAccess" }.second!!
        assertEquals("9001", home["gateCode"]!!.jsonPrimitive.content)
        assertEquals(listOf(afterPhone) to emptyList<String>(), fake.sent("saveHomeAccess"))
        onNodeWithText("Saved.").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun secondaryWithoutHomeAccess_homeDetailsLocked_profileSaves_noHomeAccessCall() = runComposeUiTest {
        val fake = viewer(canEditHome = false)
        setThemedContent { TribeScreen("Foster Household", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithTag("home-locked").performScrollTo().assertIsDisplayed()
        // Once in Home Information, once where the after-hours clinic fields were.
        assertEquals(2, onAllNodesWithText(HOME_DETAILS_LOCKED).fetchSemanticsNodes().size)
        onNodeWithTag("after-hours-locked").performScrollTo().assertIsDisplayed()
        onNodeWithText("Gate / Door Code").assertDoesNotExist()
        onNodeWithText("Key Location").assertDoesNotExist()
        onNodeWithText("Wi-Fi Password").assertDoesNotExist()
        onNodeWithText("Emergency Clinic").assertDoesNotExist()
        onNodeWithText("Emergency Clinic Phone").assertDoesNotExist()
        onNodeWithText("Foster Household").performScrollTo().performTextReplacement("Foster Two")
        waitForIdle()
        onNodeWithText("Save Changes").performScrollTo().performClick()
        waitForIdle()
        assertEquals(1, fake.calls.count { it.first == "saveTribeProfile" })
        assertTrue(fake.calls.none { it.first == "saveHomeAccess" }, "calls: ${fake.calls.map { it.first }}")
        onNodeWithText("Saved.").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun partial_homeRefusedAfterTheProfileSaves_saysWhichHalfSaved_andKeepsTheEdit() = runComposeUiTest {
        val fake = viewer(canEditHome = true)
        fake.stubError("saveHomeAccess", IllegalStateException(refused))
        setThemedContent { TribeScreen("Foster Household", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("4242").performScrollTo().performTextReplacement("9001")
        waitForIdle()
        onNodeWithText("Save Changes").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText(
            "Family and Vet Clinic saved. Home Information and the after-hours clinic did not save: " +
                "$refused Press Save Changes to try again. Your edits there are still on this page.",
        ).performScrollTo().assertIsDisplayed()
        assertTrue(onAllNodesWithText("Save failed", substring = true).fetchSemanticsNodes().isEmpty())
        onNodeWithText("Saved.").assertDoesNotExist()
        onNodeWithText("9001").performScrollTo().assertIsDisplayed()
        assertEquals(1, fake.calls.count { it.first == "saveTribeProfile" })
    }

    @Test
    fun partial_profileRefusedWhileHomeSaves_namesBothHalves() = runComposeUiTest {
        val fake = viewer(canEditHome = true)
        fake.stubError("saveTribeProfile", IllegalStateException("Too many attempts. Try again later."))
        setThemedContent { TribeScreen("Foster Household", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("4242").performScrollTo().performTextReplacement("9001")
        waitForIdle()
        onNodeWithText("Save Changes").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText(
            "Home Information and the after-hours clinic saved. Family and Vet Clinic did not save: " +
                "this household has saved too many times in the last hour. Wait a little, then save again. " +
                "Your edits there are still on this page.",
        ).performScrollTo().assertIsDisplayed()
        assertTrue(onAllNodesWithText("Save failed", substring = true).fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun pageSaveOutcome_aPartialResultIsAFailure_andAFullSaveIsNot() {
        val boom = IllegalStateException("nope")
        assertEquals(false, pageSaveOutcome(SaveHalf.Saved, SaveHalf.Failed(boom), emergencyContactsDirty = false).ok)
        assertEquals(false, pageSaveOutcome(SaveHalf.Failed(boom), SaveHalf.Saved, emergencyContactsDirty = false).ok)
        assertEquals(PageSaveStatus("Save failed: nope", ok = false), pageSaveOutcome(SaveHalf.Failed(boom), SaveHalf.Skipped, emergencyContactsDirty = false))
        assertEquals(PageSaveStatus("Saved.", ok = true), pageSaveOutcome(SaveHalf.Saved, SaveHalf.Skipped, emergencyContactsDirty = false))
        assertEquals(PageSaveStatus("Saved.", ok = true), pageSaveOutcome(SaveHalf.Saved, SaveHalf.Saved, emergencyContactsDirty = false))
    }
}
