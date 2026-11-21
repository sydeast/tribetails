package com.tribetails.auntieos.web.screens.directory

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.AddKinToVisitsAnswer
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.addKinToVisitsAnswerOf
import com.tribetails.auntieos.web.data.addKinToVisitsLabel
import com.tribetails.auntieos.web.data.addedKinToVisitsLine
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1822: the desktop console's "Add <Kin> to the N upcoming visits", through
 * the owner-only `addKinToUpcomingVisits` callable. The jvm callable answers
 * from [JvmFirestoreFixtures.callableResponses] and records every payload.
 */
@OptIn(ExperimentalTestApi::class)
class AddKinToVisitsBlockTest {
    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private fun answer(upcoming: Int, added: Int = 0) =
        """{"ok":true,"kinId":"k1","kinName":"Pepper","upcoming":$upcoming,"added":$added}"""

    private fun applies(): List<Boolean?> = JvmFirestoreFixtures.callablePayloads
        .filter { it.first == "addKinToUpcomingVisits" }
        .map { Json.parseToJsonElement(it.second).jsonObject["apply"]?.jsonPrimitive?.booleanOrNull }

    @Test
    fun decodesTheAnswerAndRefusesANonSuccess() {
        assertEquals(AddKinToVisitsAnswer("k1", "Pepper", 3, 0), addKinToVisitsAnswerOf(answer(3)))
        assertEquals(AddKinToVisitsAnswer("k1", null, 0, 0), addKinToVisitsAnswerOf("""{"ok":true,"kinId":"k1","kinName":" ","upcoming":-2,"added":1.5}"""))
        assertNull(addKinToVisitsAnswerOf("""{"kinId":"k1"}"""))
        assertNull(addKinToVisitsAnswerOf("not json"))
    }

    @Test
    fun theWordingNamesTheKinAndTheCount() {
        assertEquals("Add Pepper to the 3 upcoming visits", addKinToVisitsLabel("Pepper", 3))
        assertEquals("Add Pepper to the upcoming visit", addKinToVisitsLabel("Pepper", 1))
        assertEquals("Added Pepper to 3 upcoming visits.", addedKinToVisitsLine("Pepper", 3))
        assertEquals("Pepper is already on every upcoming visit.", addedKinToVisitsLine("Pepper", 0))
    }

    @Test
    fun theClientSendsTheHouseholdTheKinAndApply() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("addKinToUpcomingVisits" to answer(2, 2))
        val r = FirestoreClient().addKinToUpcomingVisits("kf1", " k1 ", apply = true)
        assertEquals(2, (r as WriteResult.Ok).value.added)
        val payload = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject
        assertEquals("kf1", payload["kinfolkId"]?.jsonPrimitive?.content)
        assertEquals("k1", payload["kinId"]?.jsonPrimitive?.content)
        assertEquals(true, payload["apply"]?.jsonPrimitive?.booleanOrNull)
        assertNull(JvmFirestoreFixtures.lastWrite)
    }

    @Test
    fun aBlankKinNeverReachesTheServer() = runBlocking {
        val r = FirestoreClient().addKinToUpcomingVisits("kf1", "  ", apply = false)
        assertTrue(r is WriteResult.Err)
        assertNull(JvmFirestoreFixtures.lastCallableName)
    }

    @Test
    fun asksFirstThenAddsAndSaysSo() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.callableResponses = mapOf("addKinToUpcomingVisits" to answer(3))
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                AddKinToVisitsBlock(client = FirestoreClient(), kinfolkId = "kf1", kinId = "k1", kinName = "Pepper")
            }
        }
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Add Pepper to the 3 upcoming visits").fetchSemanticsNodes().isNotEmpty() }
        onNodeWithText("Pepper is not on 3 upcoming visits.").assertExists()
        onNodeWithText("Add Pepper to the 3 upcoming visits").performClick()
        waitForIdle()
        // Nothing is written until the owner confirms.
        assertEquals(listOf<Boolean?>(false), applies())
        onNodeWithText(
            "Pepper will be on the 3 upcoming visits already booked for this household. Visits that have started or are over stay as they are.",
        ).assertExists()

        JvmFirestoreFixtures.callableResponses = mapOf("addKinToUpcomingVisits" to answer(0, 3))
        onNodeWithText("Add Pepper").performClick()
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Added Pepper to 3 upcoming visits.").fetchSemanticsNodes().isNotEmpty() }
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithTag(ADD_KIN_TO_VISITS_TAG).fetchSemanticsNodes().isEmpty() }
        assertEquals(true, applies().contains(true))
        assertNull(JvmFirestoreFixtures.lastWrite)
    }

    @Test
    fun aRefusalStaysOnTheCardAndCancelGoesBack() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.callableResponses = mapOf("addKinToUpcomingVisits" to answer(1))
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                AddKinToVisitsBlock(client = FirestoreClient(), kinfolkId = "kf1", kinId = "k1", kinName = "Pepper")
            }
        }
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Add Pepper to the upcoming visit").fetchSemanticsNodes().isNotEmpty() }
        onNodeWithText("Add Pepper to the upcoming visit").performClick()
        waitForIdle()
        JvmFirestoreFixtures.callableErrors = mapOf("addKinToUpcomingVisits" to "Only the owner can add a Kin to visits already booked.")
        onNodeWithText("Add Pepper").performClick()
        waitUntil(timeoutMillis = 5_000) {
            onAllNodesWithText("Only the owner can add a Kin to visits already booked.").fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithText("Cancel").performClick()
        waitForIdle()
        onNodeWithText("Add Pepper to the upcoming visit").assertExists()
    }

    @Test
    fun nothingIsDrawnWhenEveryUpcomingVisitHasTheKin() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.callableResponses = mapOf("addKinToUpcomingVisits" to answer(0))
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                AddKinToVisitsBlock(client = FirestoreClient(), kinfolkId = "kf1", kinId = "k1", kinName = "Pepper")
            }
        }
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Checking upcoming visits…").fetchSemanticsNodes().isEmpty() }
        assertTrue(onAllNodesWithTag(ADD_KIN_TO_VISITS_TAG).fetchSemanticsNodes().isEmpty())
    }

    @Test
    fun aFailedCountSaysSoWithRetry() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.callableErrors = mapOf("addKinToUpcomingVisits" to "offline")
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                AddKinToVisitsBlock(client = FirestoreClient(), kinfolkId = "kf1", kinId = "k1", kinName = "Pepper")
            }
        }
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Couldn't check upcoming visits").fetchSemanticsNodes().isNotEmpty() }
        JvmFirestoreFixtures.callableErrors = emptyMap()
        JvmFirestoreFixtures.callableResponses = mapOf("addKinToUpcomingVisits" to answer(2))
        onNodeWithText("Retry").performClick()
        waitUntil(timeoutMillis = 5_000) { onAllNodesWithText("Add Pepper to the 2 upcoming visits").fetchSemanticsNodes().isNotEmpty() }
    }
}
