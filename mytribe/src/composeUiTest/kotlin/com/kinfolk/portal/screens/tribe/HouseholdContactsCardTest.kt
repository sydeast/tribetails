@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.tribe

import androidx.compose.ui.test.assertIsDisplayed
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
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The Android portal's contacts card (#818), on the screen it actually lives on.
 *
 * WHAT THIS PINS THAT `HouseholdContactsPortalApiTest` CANNOT. That spec settles
 * what `PortalApi` puts on the wire. This one settles what the SCREEN hands it:
 * that the form carries a control for all four persisted fields and seeds every
 * one of them before an edit, which is the diff-vs-rebuild property
 * `buildKinfolkFromEditState` failed (a rebuild writes every field the form does
 * not show at its Kotlin default). And that a member the server refuses is told
 * who keeps the list instead of being shown a broken card.
 */
class HouseholdContactsCardTest {

    /** Everything TribeScreen loads, so only the contacts call is under test. */
    private fun FakeFunctionsClient.stubScreen() {
        stub("getMyTribeProfile", buildJsonObject {
            put("profile", buildJsonObject {
                put("kinfolkId", "fam1")
                put("displayName", "The Ramirez")
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
        stub("getVetClinics", buildJsonObject { put("clinics", buildJsonArray {}) })
        stub("listMembers", buildJsonObject { put("members", buildJsonArray {}) })
        stub("listEmergencyContacts", buildJsonObject { put("contacts", buildJsonArray {}); put("canEdit", true); put("legacy", false) })
    }

    private fun contact() = buildJsonObject {
        put("contactId", "c1")
        put("name", "Ada Rivera")
        put("label", "Sister")
        put("phone", "805 555 0143")
        put("email", "ada@example.com")
        put("createdAt", JsonNull)
        put("updatedAt", JsonNull)
    }

    @Test
    fun recordsAContactAndSaysNoAccountCameWithIt() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubScreen()
        fake.stub("listHouseholdContacts", buildJsonObject { put("contacts", buildJsonArray {}) })
        fake.stub("saveHouseholdContact", buildJsonObject { put("contactId", "c9"); put("created", true) })

        setThemedContent { TribeScreen("The Ramirez", "fam1", PortalApi(fake)) }
        waitForIdle()

        onNodeWithText("Contacts Without an Account").performScrollTo().assertIsDisplayed()
        onNodeWithText("Add a contact").performScrollTo().performClick()
        waitForIdle()

        onNodeWithTag("contact-name").performScrollTo().performTextInput("Ada Rivera")
        onNodeWithTag("contact-label").performScrollTo().performTextInput("Sister")
        onNodeWithTag("contact-phone").performScrollTo().performTextInput("805 555 0143")
        onNodeWithText("Save contact").performScrollTo().performClick()
        waitForIdle()

        val payload = fake.calls.last { it.first == "saveHouseholdContact" }.second!!
        // The key set, not just the values: a fifth key beside these is how a
        // contact would quietly become an invite.
        assertEquals(setOf("kinfolkId", "name", "label", "phone", "email"), payload.keys)
        assertNull(payload["permissions"])
        assertNull(payload["role"])
        assertEquals("Ada Rivera", payload["name"]!!.jsonPrimitive.content)

        onNodeWithText(
            "Ada Rivera is a contact on your Tribe. No portal account was created.",
        ).performScrollTo().assertIsDisplayed()
    }

    @Test
    fun editIsADiffNotARebuild_everyPersistedFieldIsSeededAndResent() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubScreen()
        fake.stub("listHouseholdContacts", buildJsonObject {
            put("contacts", buildJsonArray { add(contact()) })
        })
        fake.stub("saveHouseholdContact", buildJsonObject { put("contactId", "c1"); put("created", false) })

        setThemedContent { TribeScreen("The Ramirez", "fam1", PortalApi(fake)) }
        waitForIdle()

        // Open the editor and change NOTHING, then save. A rebuild-from-form
        // save would send the fields the form has no control for at their
        // defaults; this asserts the form seeded all four from the loaded row.
        onNodeWithText("Edit").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Save contact").performScrollTo().performClick()
        waitForIdle()

        val payload = fake.calls.last { it.first == "saveHouseholdContact" }.second!!
        assertEquals(setOf("kinfolkId", "contactId", "name", "label", "phone", "email"), payload.keys)
        assertEquals("c1", payload["contactId"]!!.jsonPrimitive.content)
        assertEquals("Ada Rivera", payload["name"]!!.jsonPrimitive.content)
        assertEquals("Sister", payload["label"]!!.jsonPrimitive.content)
        assertEquals("805 555 0143", payload["phone"]!!.jsonPrimitive.content)
        assertEquals("ada@example.com", payload["email"]!!.jsonPrimitive.content)
    }

    @Test
    fun removeAsksFirstAndThenDeletesTheRowOutright() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubScreen()
        fake.stub("listHouseholdContacts", buildJsonObject {
            put("contacts", buildJsonArray { add(contact()) })
        })
        fake.stub("removeHouseholdContact", buildJsonObject { put("ok", true) })

        setThemedContent { TribeScreen("The Ramirez", "fam1", PortalApi(fake)) }
        waitForIdle()

        onNodeWithText("Remove").performScrollTo().performClick()
        waitForIdle()
        // The confirm is a step, not a wired button: nothing has gone yet.
        assertTrue(fake.calls.none { it.first == "removeHouseholdContact" })
        onNodeWithText(
            "Remove Ada Rivera? There is no account to suspend, so the row is gone.",
        ).performScrollTo().assertIsDisplayed()

        onNodeWithText("Remove").performScrollTo().performClick()
        waitForIdle()

        val payload = fake.calls.last { it.first == "removeHouseholdContact" }.second!!
        assertEquals(setOf("kinfolkId", "contactId"), payload.keys)
        assertEquals("c1", payload["contactId"]!!.jsonPrimitive.content)
    }

    @Test
    fun aMemberWhoMayNotKeepTheListIsToldWhoDoes() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubScreen()
        // What an ACTIVE SECONDARY gets: requireKinfolkPrimary denies them on
        // all three callables, unchanged from #817.
        fake.stubError("listHouseholdContacts", IllegalStateException("PERMISSION_DENIED"))

        setThemedContent { TribeScreen("The Ramirez", "fam1", PortalApi(fake)) }
        waitForIdle()

        onNodeWithText(
            "Your primary kinfolk keeps this list. Ask them to add or change a contact.",
        ).performScrollTo().assertIsDisplayed()
        // No gesture is offered that the server will refuse.
        onNodeWithText("Add a contact").assertDoesNotExist()
    }

    @Test
    fun theInviteAndTheContactStayVisiblyApart() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubScreen()
        fake.stub("listHouseholdContacts", buildJsonObject {
            put("contacts", buildJsonArray { add(contact()) })
        })

        setThemedContent { TribeScreen("The Ramirez", "fam1", PortalApi(fake)) }
        waitForIdle()

        onNodeWithText("Invite a Kinfolk").performScrollTo().assertIsDisplayed()
        onNodeWithText("Contacts Without an Account").performScrollTo().assertIsDisplayed()
        onNodeWithText("Sister · 805 555 0143 · ada@example.com").performScrollTo().assertIsDisplayed()

        onNodeWithText("Add a contact").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText(
            "Optional, and it invites nobody. An address here is somewhere to reach this person.",
        ).performScrollTo().assertIsDisplayed()
    }

    @Test
    fun anEmptyListReadsAsEmptyAndNamesWhatAContactIs() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubScreen()
        fake.stub("listHouseholdContacts", buildJsonObject { put("contacts", buildJsonArray {}) })

        setThemedContent { TribeScreen("The Ramirez", "fam1", PortalApi(fake)) }
        waitForIdle()

        onNodeWithText(
            "Nobody is written down yet. A contact is somebody we can phone when we can't reach you. " +
                "They get no sign-in and see nothing.",
        ).performScrollTo().assertIsDisplayed()
    }
}
