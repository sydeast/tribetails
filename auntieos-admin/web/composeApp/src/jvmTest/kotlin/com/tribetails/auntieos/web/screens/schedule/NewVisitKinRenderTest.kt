package com.tribetails.auntieos.web.screens.schedule

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.HouseholdKinRoster
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.KinChoice
import com.tribetails.auntieos.web.data.KinRosterState
import com.tribetails.auntieos.web.data.RosterKin
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.visitKinLine
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #1822, #1862, #2032 on the desktop console. Operator ruling 2026-11-12:
 * every visit covers every Kin. New visit names the household's Kin from the
 * server's roster and has no picker, unless the "Visits: choose Kin" flag is
 * on. Visit detail says which Kin the visit is for.
 */
@OptIn(ExperimentalTestApi::class)
class NewVisitKinRenderTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private val home = listOf(RosterKin("k1", "Biscuit"), RosterKin("k2", "Gravy"))

    /** The "Kin covered" field of New visit, holding its own choice the way the dialog does. */
    private fun ComposeUiTest.showField(roster: KinRosterState) {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                var choice by remember { mutableStateOf(KinChoice()) }
                KinCoveredField(roster = roster, choice = choice, onToggle = { choice = choice.toggle(it, roster.kin) })
            }
        }
    }

    private fun ComposeUiTest.shown(text: String): Boolean =
        onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    // ── the call ────────────────────────────────────────────────────────────

    @Test
    fun `asks the server for the household's Kin by its id`() = runTest {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "getHouseholdKinRoster" to """{"kin":[{"id":"k1","name":"Biscuit"},{"id":"k2","name":"Gravy"}],"chooseKin":true}""",
        )
        val r = FirestoreClient().getHouseholdKinRoster("kf1")
        assertEquals(WriteResult.Ok(HouseholdKinRoster(home, chooseKin = true)), r)
        val (name, payload) = JvmFirestoreFixtures.callablePayloads.last()
        assertEquals("getHouseholdKinRoster", name)
        assertEquals("kf1", Json.parseToJsonElement(payload).jsonObject["kinfolkId"]?.jsonPrimitive?.content)
    }

    @Test
    fun `a failed call and an answer with no Kin list are both an error, never an empty home`() = runTest {
        JvmFirestoreFixtures.callableErrors = mapOf("getHouseholdKinRoster" to "internal")
        assertTrue(FirestoreClient().getHouseholdKinRoster("kf1") is WriteResult.Err)
        JvmFirestoreFixtures.callableErrors = emptyMap()
        JvmFirestoreFixtures.callableResponses = mapOf("getHouseholdKinRoster" to """{"ok":true}""")
        assertTrue(FirestoreClient().getHouseholdKinRoster("kf1") is WriteResult.Err)
    }

    @Test
    fun `no household means no call`() = runTest {
        assertTrue(FirestoreClient().getHouseholdKinRoster("") is WriteResult.Err)
        assertTrue(JvmFirestoreFixtures.callablePayloads.none { it.first == "getHouseholdKinRoster" })
    }

    // ── New visit's "Kin covered" ───────────────────────────────────────────

    @Test
    fun `choosing off - names every Kin and offers nothing to tick`() = runDesktopComposeUiTest {
        showField(KinRosterState.Ready(HouseholdKinRoster(home, chooseKin = false)))
        assertTrue(shown("Kin covered"))
        assertTrue(shown("All Kin in this home"))
        assertTrue(shown("Biscuit, Gravy"))
        assertTrue(!shown("Biscuit"), "no tick box per Kin while choosing is off")
        assertTrue(!shown("Tick at least one Kin."))
    }

    @Test
    fun `choosing on - a tick box per Kin, and unticking them all is refused in words`() = runDesktopComposeUiTest {
        showField(KinRosterState.Ready(HouseholdKinRoster(home, chooseKin = true)))
        assertTrue(shown("Biscuit"))
        assertTrue(shown("Gravy"))
        assertTrue(!shown("All Kin in this home"))
        // Every Kin starts ticked, so there is nothing to warn about yet.
        assertTrue(!shown("Tick at least one Kin."))
        onNodeWithText("Biscuit", useUnmergedTree = true).performClick()
        waitForIdle()
        assertTrue(!shown("Tick at least one Kin."))
        onNodeWithText("Gravy", useUnmergedTree = true).performClick()
        waitForIdle()
        assertTrue(shown("Tick at least one Kin."))
    }

    @Test
    fun `while the Kin are on their way it says so`() = runDesktopComposeUiTest {
        showField(KinRosterState.Loading)
        assertTrue(shown("Loading this household's Kin..."))
    }

    @Test
    fun `when the Kin cannot be loaded it says so in plain words`() = runDesktopComposeUiTest {
        showField(KinRosterState.Failed)
        assertTrue(shown("The Kin of this household could not be loaded. The visit still covers every Kin in the home."))
    }

    @Test
    fun `a household with no Kin on file reads as that`() = runDesktopComposeUiTest {
        showField(KinRosterState.Ready(HouseholdKinRoster(emptyList(), chooseKin = true)))
        assertTrue(shown("No Kin on this household yet."))
    }

    @Test
    fun `nothing about Kin is drawn before a household is picked`() = runDesktopComposeUiTest {
        showField(KinRosterState.Idle)
        assertTrue(!shown("Kin covered"))
    }

    // ── #2032 ───────────────────────────────────────────────────────────────

    @Test
    fun `a visit carries the Kin names the server stamps on it, for the Kin line on Visit detail`() {
        val session = KinCareSession(kinIds = listOf("k3"), kinNames = listOf("Pepper"))
        assertEquals("Pepper", visitKinLine(session.kinIds, session.kinNames))
    }
}
