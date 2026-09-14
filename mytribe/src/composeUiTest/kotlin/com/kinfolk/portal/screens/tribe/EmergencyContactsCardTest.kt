@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.tribe

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.assertAll
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isNotEnabled
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.runComposeUiTest
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.components.KIN_INFO_TIP_TAG
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.firebase.FunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.coroutines.CompletableDeferred
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

/**
 * #829. The portal Android Emergency Contacts card, held to what portal web's
 * `EmergencyContactsCard.test.tsx` holds its twin to: two slots in call order,
 * a pessimistic card Save that locks every control, the server's refusal word
 * for word with the typing kept, an "Unsaved changes" cue, a read-only list with
 * the #844 sentence for a member without Home access, a load failure that can be
 * retried, and a reply that never lands on a household it was not sent for.
 */
class EmergencyContactsCardTest {

    /** The card inside a scrolling column, as TribeScreen hosts it, so a tall card can be scrolled to. */
    private fun ComposeUiTest.setCard(content: @Composable () -> Unit) = setThemedContent {
        Column(Modifier.verticalScroll(rememberScrollState())) { content() }
    }

    private val locked = "Only someone with Home access can change the Emergency Contact."
    private val required = "A household needs at least one Emergency Contact."

    private fun contactJson(name: String, phone: String, relationship: String? = null) = buildJsonObject {
        put("name", name); put("phone", phone)
        if (relationship == null) put("relationship", JsonNull) else put("relationship", relationship)
        put("recordedAt", JsonNull); put("updatedAt", JsonNull)
    }

    private fun raeJson() = contactJson("Rae Mercer", "+18055550199", "Sister")

    private fun listJson(canEdit: Boolean, vararg contacts: JsonObject) = buildJsonObject {
        put("contacts", buildJsonArray { contacts.forEach { add(it) } })
        put("canEdit", canEdit); put("legacy", false)
    }

    private fun FakeFunctionsClient.list(canEdit: Boolean, withRae: Boolean) =
        stub("listEmergencyContacts", if (withRae) listJson(canEdit, raeJson()) else listJson(canEdit))

    @Test
    fun promptsAHouseholdWithNoneAndSavesTheFirstContact() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.list(canEdit = true, withRae = false)
        fake.stub("saveEmergencyContacts", buildJsonObject {
            put("contacts", buildJsonArray { add(raeJson()) })
        })
        setCard { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake)) }
        waitForIdle()
        onNodeWithText(required).assertIsDisplayed()
        onNodeWithTag("ec-0-name").performTextInput("Rae Mercer")
        onNodeWithTag("ec-0-phone").performTextInput("8055550199")
        onNodeWithText("Save Emergency Contacts").performScrollTo().performClick()
        waitForIdle()
        val payload = fake.calls.last { it.first == "saveEmergencyContacts" }.second!!
        val slot = payload["contacts"]!!.jsonArray.single().jsonObject
        assertEquals("Rae Mercer", slot["name"]!!.jsonPrimitive.content)
        assertEquals("fam1", payload["kinfolkId"]!!.jsonPrimitive.content)
        onNodeWithText("Saved.").assertIsDisplayed()
        // The prompt is about what the server holds, and the server now holds one.
        onNodeWithText(required).assertDoesNotExist()
        // Seeded from the reply: the stored E.164 phone, not the typed spelling.
        onNodeWithTag("ec-0-phone").assertTextEquals("+18055550199")
        onNodeWithText("Unsaved changes").assertDoesNotExist()
    }

    @Test
    fun anEmptyCardIsRefusedBeforeDiallingAndSaysItOnce() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.list(canEdit = true, withRae = false)
        setCard { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Save Emergency Contacts").performScrollTo().performClick()
        waitForIdle()
        assertTrue(fake.calls.none { it.first == "saveEmergencyContacts" })
        // The prompt already says it; the refusal does not repeat it.
        assertEquals(1, onAllNodesWithText(required).fetchSemanticsNodes().size)
    }

    @Test
    fun clearingTheContactsOnFileIsRefusedWithTheSentence() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.list(canEdit = true, withRae = true)
        setCard { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake)) }
        waitForIdle()
        // No prompt while the server holds one.
        onNodeWithText(required).assertDoesNotExist()
        onNodeWithTag("ec-0-name").performTextReplacement("")
        onNodeWithTag("ec-0-phone").performTextReplacement("")
        onNodeWithTag("ec-0-relationship").performTextReplacement("")
        onNodeWithText("Save Emergency Contacts").performScrollTo().performClick()
        waitForIdle()
        assertTrue(fake.calls.none { it.first == "saveEmergencyContacts" })
        assertEquals(1, onAllNodesWithText(required).fetchSemanticsNodes().size)
    }

    @Test
    fun addsASecondAndMovesItFirst() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.list(canEdit = true, withRae = true)
        fake.stub("saveEmergencyContacts", buildJsonObject { put("contacts", buildJsonArray { add(raeJson()) }) })
        setCard { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Add a second Emergency Contact").performScrollTo().performClick()
        onNodeWithTag("ec-1-name").performTextInput("Lee Park")
        onNodeWithTag("ec-1-phone").performTextInput("8055550177")
        onNodeWithText("Unsaved changes").assertIsDisplayed()
        // Two slots means no third offer.
        onNodeWithText("Add a second Emergency Contact").assertDoesNotExist()
        onNodeWithText("Call first").performScrollTo().performClick()
        onNodeWithText("Save Emergency Contacts").performScrollTo().performClick()
        waitForIdle()
        val slots = fake.calls.last { it.first == "saveEmergencyContacts" }.second!!["contacts"]!!.jsonArray
        assertEquals(listOf("Lee Park", "Rae Mercer"), slots.map { it.jsonObject["name"]!!.jsonPrimitive.content })
    }

    @Test
    fun removesTheSecond() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.list(canEdit = true, withRae = true)
        setCard { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Add a second Emergency Contact").performScrollTo().performClick()
        assertEquals(2, onAllNodesWithText("Remove").fetchSemanticsNodes().size)
        onAllNodesWithText("Remove")[1].performScrollTo().performClick()
        assertTrue(onAllNodesWithTag("ec-1-name").fetchSemanticsNodes().isEmpty())
        // One slot left: nothing to remove, and the edit is back to the stored copy.
        assertTrue(onAllNodesWithText("Remove").fetchSemanticsNodes().isEmpty())
        onNodeWithText("Unsaved changes").assertDoesNotExist()
    }

    @Test
    fun readOnlyWithoutHomeAccess() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.list(canEdit = false, withRae = true)
        setCard { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Rae Mercer").assertIsDisplayed()
        onNodeWithText("Called first").assertIsDisplayed()
        onNodeWithText("Sister").assertIsDisplayed()
        // The phone is a tap to call.
        onNode(hasText("+18055550199") and hasClickAction()).assertIsDisplayed()
        onNodeWithText(locked).assertIsDisplayed()
        assertTrue(onAllNodesWithText("Save Emergency Contacts").fetchSemanticsNodes().isEmpty())
        assertTrue(onAllNodesWithTag("ec-0-name").fetchSemanticsNodes().isEmpty())
    }

    // #829 review item 12: read-only wording that names who can add one.
    @Test
    fun readOnlyWithNoneOnFileSaysWhoCanAddOne() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.list(canEdit = false, withRae = false)
        setCard { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("No Emergency Contact on file. Someone with Home access can add one.").assertIsDisplayed()
        onNodeWithText(required).assertDoesNotExist()
        onNodeWithText(locked).assertDoesNotExist()
        assertTrue(onAllNodesWithTag("ec-0-name").fetchSemanticsNodes().isEmpty())
    }

    // #829 review item 14.
    @Test
    fun aStraySpaceIsNotAnUnsavedChange() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.list(canEdit = true, withRae = true)
        setCard { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake)) }
        waitForIdle()
        onNodeWithTag("ec-0-name").performTextReplacement("Rae Mercer ")
        waitForIdle()
        onNodeWithText("Unsaved changes").assertDoesNotExist()
        onNodeWithTag("ec-0-name").performTextReplacement("Rae Mercer Jr")
        waitForIdle()
        onNodeWithText("Unsaved changes").assertIsDisplayed()
    }

    // #829 review item 4: the server's own wording before the round trip.
    @Test
    fun aMissingPhoneIsRefusedInTheServerWording() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.list(canEdit = true, withRae = true)
        setCard { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake)) }
        waitForIdle()
        onNodeWithTag("ec-0-phone").performTextReplacement("")
        onNodeWithText("Save Emergency Contacts").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("An Emergency Contact needs a phone number.").assertIsDisplayed()
        assertTrue(fake.calls.none { it.first == "saveEmergencyContacts" })
    }

    @Test
    fun withHomeAccessThereIsNoLockLine() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.list(canEdit = true, withRae = true)
        setCard { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake)) }
        waitForIdle()
        onNodeWithText(locked).assertDoesNotExist()
        onNodeWithTag("ec-0-name").assertTextEquals("Rae Mercer")
    }

    @Test
    fun showsTheServerRefusalVerbatimAndKeepsTheTyping() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.list(canEdit = true, withRae = true)
        fake.stubError("saveEmergencyContacts", IllegalStateException("An Emergency Contact has to be someone outside the household."))
        setCard { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake)) }
        waitForIdle()
        onNodeWithTag("ec-0-name").performTextReplacement("Rae Mercer Jr")
        onNodeWithText("Save Emergency Contacts").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("An Emergency Contact has to be someone outside the household.").assertIsDisplayed()
        onNodeWithTag("ec-0-name").assertTextEquals("Rae Mercer Jr")
        onNodeWithText("Unsaved changes").assertIsDisplayed()
    }

    @Test
    fun anEditAfterASaveClearsSaved() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.list(canEdit = true, withRae = true)
        fake.stub("saveEmergencyContacts", buildJsonObject { put("contacts", buildJsonArray { add(raeJson()) }) })
        setCard { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Save Emergency Contacts").performScrollTo().performClick()
        waitForIdle()
        onNodeWithText("Saved.").assertIsDisplayed()
        onNodeWithTag("ec-0-relationship").performTextInput("!")
        onNodeWithText("Saved.").assertDoesNotExist()
    }

    @Test
    fun reportsUnsavedEditsToThePage() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.list(canEdit = true, withRae = true)
        var dirty = false
        setCard { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake), onDirtyChange = { dirty = it }) }
        waitForIdle()
        assertEquals(false, dirty)
        onNodeWithTag("ec-0-name").performTextReplacement("Rae Mercer Jr")
        waitForIdle()
        assertEquals(true, dirty)
    }

    @Test
    fun aSaveInFlightSaysSoAndLocksEveryControl() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.list(canEdit = true, withRae = true)
        var gate = CompletableDeferred<JsonObject>()
        val gated = object : FunctionsClient {
            override suspend fun call(name: String, payload: JsonObject?): JsonObject =
                if (name == "saveEmergencyContacts") gate.await() else fake.call(name, payload)
        }
        setCard { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(gated)) }
        waitForIdle()

        // One slot: Save, Add and the inputs are on screen.
        onNodeWithText("Save Emergency Contacts").performScrollTo().performClick()
        mainClock.advanceTimeBy(100L)
        onNodeWithText("Saving…").assertIsDisplayed().assertIsNotEnabled()
        onNodeWithText("Add a second Emergency Contact").assertIsNotEnabled()
        onNodeWithTag("ec-0-name").assertIsNotEnabled()
        onNodeWithTag("ec-0-phone").assertIsNotEnabled()
        onNodeWithTag("ec-0-relationship").assertIsNotEnabled()
        gate.complete(buildJsonObject { put("contacts", buildJsonArray { add(raeJson()) }) })
        waitForIdle()
        onNodeWithText("Saved.").assertIsDisplayed()
        onNodeWithText("Save Emergency Contacts").assertIsEnabled()

        // Two slots: Call first and both Removes are on screen.
        gate = CompletableDeferred()
        onNodeWithText("Add a second Emergency Contact").performScrollTo().performClick()
        onNodeWithTag("ec-1-name").performTextInput("Lee Park")
        onNodeWithTag("ec-1-phone").performTextInput("8055550177")
        onNodeWithText("Save Emergency Contacts").performScrollTo().performClick()
        mainClock.advanceTimeBy(100L)
        onNodeWithText("Saving…").assertIsNotEnabled()
        onNodeWithText("Call first").assertIsNotEnabled()
        assertEquals(2, onAllNodesWithText("Remove").fetchSemanticsNodes().size)
        onAllNodesWithText("Remove").assertAll(isNotEnabled())
        onNodeWithTag("ec-1-name").assertIsNotEnabled()
        gate.complete(buildJsonObject {
            put("contacts", buildJsonArray { add(raeJson()); add(contactJson("Lee Park", "+18055550177")) })
        })
        waitForIdle()
        onNodeWithText("Call first").assertIsEnabled()
    }

    @Test
    fun aLoadFailureSaysSoAndCanBeTriedAgain() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubError("listEmergencyContacts", IllegalStateException("boom"))
        setCard { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Couldn't load your Emergency Contacts right now.").assertIsDisplayed()
        assertTrue(onAllNodesWithText("Save Emergency Contacts").fetchSemanticsNodes().isEmpty())

        fake.list(canEdit = true, withRae = true)
        onNodeWithText("Try again").performClick()
        waitForIdle()
        onNodeWithText("Couldn't load your Emergency Contacts right now.").assertDoesNotExist()
        onNodeWithTag("ec-0-name").assertTextEquals("Rae Mercer")
        assertEquals(2, fake.calls.count { it.first == "listEmergencyContacts" })
    }

    @Test
    fun aReplyForAHouseholdNoLongerOnScreenIsDropped() = runComposeUiTest {
        val gate = CompletableDeferred<JsonObject>()
        val client = object : FunctionsClient {
            override suspend fun call(name: String, payload: JsonObject?): JsonObject = when (name) {
                "listEmergencyContacts" ->
                    if (payload?.get("kinfolkId")?.jsonPrimitive?.content == "fam2") {
                        listJson(true, contactJson("Lee Park", "+18055550177"))
                    } else {
                        listJson(true, raeJson())
                    }
                "saveEmergencyContacts" -> gate.await()
                else -> error("unexpected $name")
            }
        }
        var household by mutableStateOf("fam1")
        setCard { EmergencyContactsCard(kinfolkId = household, portalApi = PortalApi(client)) }
        waitForIdle()
        onNodeWithTag("ec-0-name").performTextReplacement("Rae Mercer Jr")
        onNodeWithText("Save Emergency Contacts").performScrollTo().performClick()
        mainClock.advanceTimeBy(100L)
        onNodeWithText("Saving…").assertIsDisplayed()

        household = "fam2"
        waitForIdle()
        onNodeWithTag("ec-0-name").assertTextEquals("Lee Park")
        // The busy Save belonged to the other household.
        onNodeWithText("Save Emergency Contacts").assertIsEnabled()

        gate.complete(buildJsonObject { put("contacts", buildJsonArray { add(contactJson("Rae Mercer Jr", "+18055550199")) }) })
        waitForIdle()
        onNodeWithTag("ec-0-name").assertTextEquals("Lee Park")
        onNodeWithText("Saved.").assertDoesNotExist()
        onNodeWithText("Unsaved changes").assertDoesNotExist()
        onNodeWithText("Save Emergency Contacts").assertIsEnabled()
    }

    @Test
    fun atPhoneWidthTheTitleAndTipBothShowAndDoNotOverlap() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.list(canEdit = true, withRae = true)
        setThemedContent {
            Box(Modifier.width(360.dp)) { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake)) }
        }
        waitForIdle()
        val title = onNodeWithText("Emergency Contacts").assertIsDisplayed().getUnclippedBoundsInRoot()
        val tip = onNodeWithTag(KIN_INFO_TIP_TAG).assertIsDisplayed().getUnclippedBoundsInRoot()
        assertTrue(tip.right - tip.left > 0.dp && title.right - title.left > 0.dp, "title $title, tip $tip")
        val apartSideways = title.right <= tip.left || tip.right <= title.left
        val apartUpDown = title.bottom <= tip.top || tip.bottom <= title.top
        assertTrue(apartSideways || apartUpDown, "title $title overlaps tip $tip")
        assertTrue(tip.right <= 360.dp && title.right <= 360.dp, "title $title, tip $tip past 360dp")
    }
}
