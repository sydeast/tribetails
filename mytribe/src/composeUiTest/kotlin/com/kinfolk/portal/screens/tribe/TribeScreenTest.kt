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

    private fun FakeFunctionsClient.stubProfileWithSavedField(canEditHomeDetails: Boolean? = null) {
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
            // Optional: existing callers that don't care about Home access leave
            // this null and the field is omitted, same as before this parameter
            // existed (#933 item 3).
            if (canEditHomeDetails != null) put("canEditHomeDetails", canEditHomeDetails)
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

    private fun FakeFunctionsClient.stubProfileWithVetClinicFields() {
        stub("getMyTribeProfile", buildJsonObject {
            put("profile", buildJsonObject {
                put("kinfolkId", "3")
                put("displayName", "The Foster")
                put("customFields", buildJsonArray {
                    add(buildJsonObject { put("key", "vetClinicName"); put("label", "Vet Clinic"); put("value", "Ridgeline Animal Hospital") })
                    add(buildJsonObject { put("key", "vetClinicPhone"); put("label", "Vet Clinic Phone"); put("value", "805-555-0170") })
                    add(buildJsonObject { put("key", "vetClinicAddress"); put("label", "Vet Clinic Address"); put("value", "12 Ridge Rd") })
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

    /**
     * #872: a household with a saved vet clinic used to see it twice on
     * Android — once editable in the Vet Clinic card, once read-only as a
     * "Set by your Auntie" row, because CustomFieldList's ownedElsewhere set
     * never listed the vetClinic* keys. Each value must render exactly once.
     */
    @Test
    fun vetClinicCustomFields_showOnlyInTheVetClinicCard_neverAsAReadOnlyDuplicate() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubProfileWithVetClinicFields()
        fake.stubEmergencyContacts()
        fake.stub("getVetClinics", buildJsonObject { put("clinics", buildJsonArray {}) })
        setThemedContent { TribeScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Ridgeline Animal Hospital").performScrollTo().assertIsDisplayed()
        assertEquals(1, onAllNodesWithText("Ridgeline Animal Hospital").fetchSemanticsNodes().size)
        assertEquals(1, onAllNodesWithText("805-555-0170").fetchSemanticsNodes().size)
        assertEquals(1, onAllNodesWithText("12 Ridge Rd").fetchSemanticsNodes().size)
        // This profile's only customFields are the vet clinic's own; once
        // CustomFieldList hides them there is nothing left for the read-only
        // "Set by your Auntie" note to introduce.
        onNodeWithText("Set by your Auntie. Ask them to update these.").assertDoesNotExist()
        // Same rule for the section header above the list: it must read off
        // the same filtered set, or a vet-clinic-only profile shows
        // "PROFILE FIELDS" over an empty read-only list.
        onNodeWithText("PROFILE FIELDS").assertDoesNotExist()
    }

    /**
     * #933 item 3. The After-hours block itself always renders (its header and
     * blurb are unconditional), but the editable "Emergency Clinic" fields only
     * show when the viewer has Home access (#919's `canEditHomeDetails`); without
     * it they are replaced by [HOME_DETAILS_LOCKED]. This was named
     * `afterHoursVet_alwaysVisible` and only passed because its fixture omitted
     * `canEditHomeDetails`, which `?: true` reads as allowed. It never pinned
     * the no-access half of the rule.
     */
    @Test
    fun afterHoursVet_visibleWheneverViewerHasHomeAccess() = runComposeUiTest {
        val withHomeAccess = FakeFunctionsClient()
        withHomeAccess.stubProfileWithSavedField(canEditHomeDetails = true)
        withHomeAccess.stubEmergencyContacts()
        setThemedContent { TribeScreen("The Foster", "3", PortalApi(withHomeAccess)) }
        waitForIdle()
        // The after-hours block lives inside the vet clinic card, below the fold.
        onNodeWithText("After-hours").performScrollTo().assertIsDisplayed()
        onNodeWithText("Emergency Clinic").performScrollTo().assertIsDisplayed()
        onNodeWithText("Emergency Clinic Phone").performScrollTo().assertIsDisplayed()
    }

    @Test
    fun afterHoursVet_lockedWithoutHomeAccess() = runComposeUiTest {
        val withoutHomeAccess = FakeFunctionsClient()
        withoutHomeAccess.stubProfileWithSavedField(canEditHomeDetails = false)
        withoutHomeAccess.stubEmergencyContacts(canEdit = false)
        setThemedContent { TribeScreen("The Foster", "3", PortalApi(withoutHomeAccess)) }
        waitForIdle()
        // The header stays visible, but the editable fields do not.
        onNodeWithText("After-hours").performScrollTo().assertIsDisplayed()
        onNodeWithTag("after-hours-locked").performScrollTo().assertIsDisplayed()
        onNodeWithText("Emergency Clinic").assertDoesNotExist()
        onNodeWithText("Emergency Clinic Phone").assertDoesNotExist()
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

    private fun schemaJson(id: String, vararg fields: Pair<String, String>, defaults: Map<String, String> = emptyMap()) = buildJsonObject {
        put("id", id); put("name", id); put("version", 1)
        put("sections", buildJsonArray {
            add(buildJsonObject {
                put("title", "Details for $id")
                put("fields", buildJsonArray {
                    fields.forEach { (key, label) ->
                        add(buildJsonObject {
                            put("key", key); put("label", label); put("type", "text")
                            defaults[key]?.let { put("defaultValue", it) }
                        })
                    }
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

    /**
     * #901. A schema `defaultValue` is a HINT, not a value.
     *
     * Portal web seeded an empty schema field with the default as its VALUE while
     * the save sent nothing for a key that was never stored, so the screen and the
     * record disagreed. This client never applied defaults at all, so what it
     * STORES is unchanged; it now shows the same hint web does, which is what
     * makes the two clients consistent.
     */
    private fun defaultsHousehold(): Pair<FakeFunctionsClient, PortalApi> {
        val fake = FakeFunctionsClient()
        fake.stub("getMyTribeProfile", buildJsonObject {
            put("profile", buildJsonObject {
                put("kinfolkId", "3"); put("displayName", "The Foster"); put("customFields", rowsJson(allergy))
            })
            put("homeAccess", buildJsonObject {
                put("gateCode", JsonNull); put("keyLocation", JsonNull); put("wifiPassword", JsonNull)
                put("customFields", buildJsonArray {}); put("updatedAtMs", JsonNull)
            })
        })
        fake.stubEmergencyContacts()
        fake.stub("getVetClinics", buildJsonObject { put("clinics", buildJsonArray {}) })
        fake.stub("listMembers", buildJsonObject { put("members", buildJsonArray {}) })
        fake.stub("listHouseholdContacts", buildJsonObject { put("contacts", buildJsonArray {}) })
        fake.stub("saveTribeProfile", buildJsonObject { put("ok", true) })
        fake.stub("saveHomeAccess", buildJsonObject { put("ok", true) })
        val schemas = mapOf(
            "tribeProfile" to schemaJson(
                "tribeProfile",
                "displayName" to "Family Display Name",
                "allergy" to "Allergies",
                "feeding" to "Feeding notes",
                defaults = mapOf("feeding" to "Twice a day"),
            ),
        )
        return fake to PortalApi(SchemaFunctions(fake, schemas))
    }

    @Test
    fun schemaDefault_showsAsAHint_andIsNeverStored() = runComposeUiTest {
        val (fake, api) = defaultsHousehold()
        setThemedContent { TribeScreen("The Foster", "3", api) }
        waitForIdle()
        // The default is nowhere on screen as a VALUE (it rides on the field's
        // placeholder, which Material only paints while the field has focus).
        assertTrue(
            onAllNodesWithText("Twice a day").fetchSemanticsNodes().isEmpty(),
            "the default is showing as a value",
        )
        onNodeWithText("Save Changes").performScrollTo().performClick()
        waitForIdle()
        // And the save stores nothing for that key, so the screen and the record agree.
        val (rows, removed) = fake.sent("saveTribeProfile")
        assertTrue(rows.none { it.first == "feeding" }, "rows: $rows")
        assertEquals(emptyList<String>(), removed)
        assertEquals(listOf(allergy), rows)
    }

    // ---- #868: the home details follow Home access, and a partial save says so ----

    /** A household as getMyTribeProfile serves it to a viewer with or without Home access. */
    private fun viewer(canEditHome: Boolean, keyLocation: String? = null, wifiPassword: String? = null): FakeFunctionsClient {
        val fake = FakeFunctionsClient()
        fake.stub("getMyTribeProfile", buildJsonObject {
            put("profile", buildJsonObject {
                put("kinfolkId", "3"); put("displayName", "Foster Household"); put("customFields", buildJsonArray {})
            })
            put("homeAccess", buildJsonObject {
                // The server sends no home values without the grant (getMyTribeProfile.ts).
                if (canEditHome) put("gateCode", "4242") else put("gateCode", JsonNull)
                put("keyLocation", if (canEditHome) keyLocation else null)
                put("wifiPassword", if (canEditHome) wifiPassword else null)
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

    /**
     * #901. Clearing the gate code used to reach the server as nothing at all:
     * PortalApi dropped a null from the payload, saveHomeAccess reads an absent
     * key as "leave it alone", and the screen still said "Saved." while the old
     * code stayed stored. The clear has to arrive as an explicit JSON null, the
     * same clear portal web already sends.
     */
    @Test
    fun clearedGateCode_reachesTheServerAsAnExplicitNull() = runComposeUiTest {
        val fake = viewer(canEditHome = true)
        setThemedContent { TribeScreen("Foster Household", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("4242").performScrollTo().performTextClearance()
        waitForIdle()
        onNodeWithText("Save Changes").performScrollTo().performClick()
        waitForIdle()
        val home = fake.calls.last { it.first == "saveHomeAccess" }.second!!
        assertTrue(home.containsKey("gateCode"), "gateCode missing from the payload: $home")
        assertEquals(JsonNull, home["gateCode"])
        onNodeWithText("Saved.").performScrollTo().assertIsDisplayed()
    }

    /**
     * #901. All three scalars ride on every call, so an empty field is never
     * ambiguous between "cleared" and "not part of this save". keyLocation and
     * wifiPassword are unset on this household and are still sent, as nulls the
     * server reads as no change (a sent null matching a missing field).
     */
    @Test
    fun homeAccessSave_alwaysCarriesGateCodeKeyLocationAndWifi() = runComposeUiTest {
        val fake = viewer(canEditHome = true)
        setThemedContent { TribeScreen("Foster Household", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("4242").performScrollTo().performTextReplacement("9001")
        waitForIdle()
        onNodeWithText("Save Changes").performScrollTo().performClick()
        waitForIdle()
        val home = fake.calls.last { it.first == "saveHomeAccess" }.second!!
        assertEquals("9001", home["gateCode"]!!.jsonPrimitive.content)
        assertTrue(home.containsKey("keyLocation"), "keyLocation missing from the payload: $home")
        assertTrue(home.containsKey("wifiPassword"), "wifiPassword missing from the payload: $home")
        assertEquals(JsonNull, home["keyLocation"])
        assertEquals(JsonNull, home["wifiPassword"])
    }

    /** #901: a cleared key location and Wi-Fi password clear too, not just the gate code. */
    @Test
    fun clearedKeyLocationAndWifi_reachTheServerAsExplicitNulls() = runComposeUiTest {
        val fake = viewer(canEditHome = true, keyLocation = "Under the mat", wifiPassword = "TribeNet")
        setThemedContent { TribeScreen("Foster Household", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Under the mat").performScrollTo().performTextClearance()
        onNodeWithText("TribeNet").performScrollTo().performTextClearance()
        waitForIdle()
        onNodeWithText("Save Changes").performScrollTo().performClick()
        waitForIdle()
        val home = fake.calls.last { it.first == "saveHomeAccess" }.second!!
        assertEquals(JsonNull, home["keyLocation"])
        assertEquals(JsonNull, home["wifiPassword"])
        // The gate code was not touched, and rides along unchanged rather than as a clear.
        assertEquals("4242", home["gateCode"]!!.jsonPrimitive.content)
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

    /** #930: reporting only the profile half's reason drops the home access one. */
    @Test
    fun pageSaveOutcome_bothHalvesFailingForDifferentReasons_namesBoth() {
        val profileError = IllegalStateException("nope")
        val homeError = IllegalStateException("kaput")
        val outcome = pageSaveOutcome(SaveHalf.Failed(profileError), SaveHalf.Failed(homeError), emergencyContactsDirty = false)
        assertEquals(false, outcome.ok)
        assertTrue(outcome.text.contains("Family and Vet Clinic did not save: nope."))
        assertTrue(outcome.text.contains("Home Information and the after-hours clinic did not save: kaput."))
    }

    /**
     * #930: a Save click sends both callables together, so both hitting the same
     * rate limit at once is the common case. The reason must not be named twice.
     */
    @Test
    fun pageSaveOutcome_bothHalvesFailingForTheSameReason_statesItOnce() {
        val sameBoom = IllegalStateException("nope")
        val outcome = pageSaveOutcome(SaveHalf.Failed(sameBoom), SaveHalf.Failed(sameBoom), emergencyContactsDirty = false)
        assertEquals(
            PageSaveStatus("Save failed: nope. Press Save Changes to try again. Your edits are still on this page.", ok = false),
            outcome,
        )
        assertEquals(1, Regex("Press Save Changes to try again").findAll(outcome.text).count())
    }

    /**
     * #868: the row building around the two callables is not inside either half's
     * catch. Left unattributed it would fall through to "Saved." over a save that
     * never happened, which is the bug this issue is about, in the other direction.
     */
    @Test
    fun blameUnfinishedHalf_attributesAThrowBetweenTheCallsToTheHalfItWasBuildingFor() {
        val boom = IllegalStateException("nope")
        // Before either call: the profile half never happened.
        assertEquals(SaveHalf.Failed(boom) to SaveHalf.Skipped, blameUnfinishedHalf(SaveHalf.Skipped, SaveHalf.Skipped, boom))
        // After the profile saved: the home half never happened.
        assertEquals(SaveHalf.Saved to SaveHalf.Failed(boom), blameUnfinishedHalf(SaveHalf.Saved, SaveHalf.Skipped, boom))
        // Both settled already: nothing left to blame.
        assertEquals(SaveHalf.Saved to SaveHalf.Saved, blameUnfinishedHalf(SaveHalf.Saved, SaveHalf.Saved, boom))
        assertEquals(SaveHalf.Failed(boom) to SaveHalf.Saved, blameUnfinishedHalf(SaveHalf.Failed(boom), SaveHalf.Saved, boom))

        val (profile, home) = blameUnfinishedHalf(SaveHalf.Skipped, SaveHalf.Skipped, boom)
        assertEquals(PageSaveStatus("Save failed: nope", ok = false), pageSaveOutcome(profile, home, emergencyContactsDirty = false))
    }
}
