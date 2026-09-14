@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.tribe

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.runComposeUiTest
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
 * a pessimistic card Save that locks the inputs, the server's refusal word for
 * word with the typing kept, an "Unsaved changes" cue, and a read-only list with
 * the #844 sentence for a member without Home access.
 */
class EmergencyContactsCardTest {

    /** The card inside a scrolling column, as TribeScreen hosts it, so a tall card can be scrolled to. */
    private fun ComposeUiTest.setCard(content: @Composable () -> Unit) = setThemedContent {
        Column(Modifier.verticalScroll(rememberScrollState())) { content() }
    }

    private val locked ="Only someone with Home access can change the Emergency Contact."
    private val required = "A household needs at least one Emergency Contact"

    private fun raeJson() = buildJsonObject {
        put("name", "Rae Mercer"); put("phone", "+18055550199"); put("relationship", "Sister"); put("recordedAt", JsonNull); put("updatedAt", JsonNull)
    }

    private fun FakeFunctionsClient.list(canEdit: Boolean, withRae: Boolean) = stub("listEmergencyContacts", buildJsonObject {
        put("contacts", buildJsonArray { if (withRae) add(raeJson()) })
        put("canEdit", canEdit); put("legacy", false)
    })

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
    fun anEmptyCardIsRefusedBeforeDialling() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.list(canEdit = true, withRae = false)
        setCard { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Save Emergency Contacts").performScrollTo().performClick()
        waitForIdle()
        assertTrue(fake.calls.none { it.first == "saveEmergencyContacts" })
        assertEquals(2, onAllNodesWithText(required).fetchSemanticsNodes().size)
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

    @Test
    fun readOnlyWithNoneOnFileStillPrompts() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.list(canEdit = false, withRae = false)
        setCard { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake)) }
        waitForIdle()
        onNodeWithText(required).assertIsDisplayed()
        onNodeWithText(locked).assertIsDisplayed()
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
    fun aSaveInFlightSaysSoAndLocksTheInputs() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.list(canEdit = true, withRae = true)
        val gate = CompletableDeferred<JsonObject>()
        val gated = object : FunctionsClient {
            override suspend fun call(name: String, payload: JsonObject?): JsonObject =
                if (name == "saveEmergencyContacts") gate.await() else fake.call(name, payload)
        }
        setCard { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(gated)) }
        waitForIdle()
        onNodeWithText("Save Emergency Contacts").performScrollTo().performClick()
        mainClock.advanceTimeBy(100L)
        onNodeWithText("Saving…").assertIsDisplayed()
        onNodeWithTag("ec-0-name").assertIsNotEnabled()
        onNodeWithTag("ec-0-phone").assertIsNotEnabled()
        onNodeWithTag("ec-0-relationship").assertIsNotEnabled()
        gate.complete(buildJsonObject { put("contacts", buildJsonArray { add(raeJson()) }) })
        waitForIdle()
        onNodeWithText("Saved.").assertIsDisplayed()
    }

    @Test
    fun aLoadFailureSaysSo() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubError("listEmergencyContacts", IllegalStateException("boom"))
        setCard { EmergencyContactsCard(kinfolkId = "fam1", portalApi = PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Couldn't load your Emergency Contacts right now.").assertIsDisplayed()
        assertTrue(onAllNodesWithText("Save Emergency Contacts").fetchSemanticsNodes().isEmpty())
    }
}
