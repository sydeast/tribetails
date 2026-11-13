package com.tribetails.auntieos.web.screens.directory

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.KINFOLK_ARCHIVE_OWNER_ONLY
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.TestMode
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.kinfolkArchiveOffered
import com.tribetails.auntieos.web.data.kinfolkArchiveRefusalText
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
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #2161, operator ruling 2026-11-13: only the owner archives or restores a
 * Kinfolk household. The console's Archive, and its new Restore, go through
 * the owner-only `setKinfolkArchived` callable, never a direct write of
 * `kinfolk/{id}`, and write no client Activity Log line (the server writes it).
 * The jvm callable answers from [JvmFirestoreFixtures.callableResponses]; any
 * direct write would land in `lastWrite`.
 */
@OptIn(ExperimentalTestApi::class)
class KinfolkArchiveCallableTest {
    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.clear()
        FirestoreClient.setSessionTestMode(TestMode.OFF)
    }

    private fun payload() = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject

    // ── the client ─────────────────────────────────────────────────────────

    @Test
    fun archiveCallsTheCallableWithTheIdAndArchivedTrue() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("setKinfolkArchived" to """{"ok":true,"archived":true,"status":"archived","changed":true}""")
        val r = FirestoreClient().archiveKinfolk(" kf1 ")
        assertTrue(r is WriteResult.Ok)
        assertEquals("setKinfolkArchived", JvmFirestoreFixtures.lastCallableName)
        assertEquals("kf1", payload()["kinfolkId"]?.jsonPrimitive?.content)
        assertEquals(true, payload()["archived"]?.jsonPrimitive?.booleanOrNull)
        assertNull(JvmFirestoreFixtures.lastWrite)
    }

    @Test
    fun restoreCallsTheSameCallableWithArchivedFalseAndNoReason() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("setKinfolkArchived" to """{"ok":true,"archived":false,"status":"active","changed":true}""")
        val r = FirestoreClient().restoreKinfolk("kf1")
        assertTrue(r is WriteResult.Ok)
        assertEquals(false, payload()["archived"]?.jsonPrimitive?.booleanOrNull)
        assertFalse(payload().containsKey("reason"))
        assertNull(JvmFirestoreFixtures.lastWrite)
    }

    @Test
    fun theServersRefusalReadsAsTheOwnerOnlySentence() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("setKinfolkArchived" to "Admin claim required.")
        val r = FirestoreClient().archiveKinfolk("kf1")
        assertEquals(KINFOLK_ARCHIVE_OWNER_ONLY, (r as WriteResult.Err).message)
        assertEquals("Only the owner can archive or restore a Kinfolk household.", KINFOLK_ARCHIVE_OWNER_ONLY)
    }

    @Test
    fun otherFailuresKeepTheirOwnWords() {
        assertEquals("The server could not be reached. Try again in a moment.", kinfolkArchiveRefusalText("The server could not be reached. Try again in a moment."))
        assertEquals(KINFOLK_ARCHIVE_OWNER_ONLY, kinfolkArchiveRefusalText("Your account is not allowed to do this."))
    }

    @Test
    fun aBlankIdNeverReachesTheServer() = runBlocking {
        val r = FirestoreClient().archiveKinfolk("  ")
        assertTrue(r is WriteResult.Err)
        assertNull(JvmFirestoreFixtures.lastCallableName)
    }

    @Test
    fun aSandboxTestAdminIsNotOfferedArchive() {
        assertTrue(kinfolkArchiveOffered(TestMode.OFF))
        assertFalse(kinfolkArchiveOffered(TestMode(active = true, testTribeId = "sandbox")))
    }

    // ── the screen ─────────────────────────────────────────────────────────

    private fun household(status: String) = Kinfolk(
        _id = "kf1",
        firstName = "Dana",
        lastName = "Mercer",
        phoneNumber = "8055550100",
        serviceAddress = "12",
        status = status,
    )

    private fun noCustomFields() {
        JvmFirestoreFixtures.callableResponses = mapOf("listFormSchemas" to """{"schemas":[]}""")
    }

    @Test
    fun theOwnerRestoresAnArchivedHouseholdThroughTheCallable() = runDesktopComposeUiTest {
        noCustomFields()
        JvmFirestoreFixtures.callableResponses += mapOf("setKinfolkArchived" to """{"ok":true,"archived":false,"status":"active","changed":true}""")
        JvmFirestoreFixtures.kinfolk = listOf(household("archived"))
        var left = false
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinfolkEditScreen(kinfolkId = "kf1", onBack = {}, onSaved = {}, onArchived = { left = true })
            }
        }
        waitForIdle()
        onNodeWithText("Restore").performScrollTo().performClick()
        waitUntil(timeoutMillis = 5_000) { left }
        assertEquals("setKinfolkArchived", JvmFirestoreFixtures.lastCallableName)
        assertEquals(false, payload()["archived"]?.jsonPrimitive?.booleanOrNull)
        assertNull(JvmFirestoreFixtures.lastWrite)
        // The server writes the Activity Log line; the console sends no logActivity.
        assertTrue(JvmFirestoreFixtures.callablePayloads.none { it.first == "logActivity" })
    }

    @Test
    fun theOwnerArchivesThroughTheCallableAndWritesNoClientLine() = runDesktopComposeUiTest {
        noCustomFields()
        JvmFirestoreFixtures.callableResponses += mapOf("setKinfolkArchived" to """{"ok":true,"archived":true,"status":"archived","changed":true}""")
        JvmFirestoreFixtures.kinfolk = listOf(household("active"))
        var left = false
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinfolkEditScreen(kinfolkId = "kf1", onBack = {}, onSaved = {}, onArchived = { left = true })
            }
        }
        waitForIdle()
        onNodeWithText("Archive").performScrollTo().performClick()
        waitUntil(timeoutMillis = 5_000) { left }
        assertEquals("setKinfolkArchived", JvmFirestoreFixtures.lastCallableName)
        assertEquals(true, payload()["archived"]?.jsonPrimitive?.booleanOrNull)
        assertNull(JvmFirestoreFixtures.lastWrite)
        assertTrue(JvmFirestoreFixtures.callablePayloads.none { it.first == "logActivity" })
    }

    @Test
    fun aRefusedRestoreShowsThePlainSentenceAndStaysOnTheScreen() = runDesktopComposeUiTest {
        noCustomFields()
        JvmFirestoreFixtures.callableErrors = mapOf("setKinfolkArchived" to "Admin claim required.")
        JvmFirestoreFixtures.kinfolk = listOf(household("archived"))
        var left = false
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinfolkEditScreen(kinfolkId = "kf1", onBack = {}, onSaved = {}, onArchived = { left = true })
            }
        }
        waitForIdle()
        onNodeWithText("Restore").performScrollTo().performClick()
        waitUntil(timeoutMillis = 5_000) {
            onAllNodesWithText("Restore failed: $KINFOLK_ARCHIVE_OWNER_ONLY").fetchSemanticsNodes().isNotEmpty()
        }
        assertFalse(left)
    }

    @Test
    fun aSandboxSessionSeesNoArchivePanel() = runDesktopComposeUiTest {
        noCustomFields()
        FirestoreClient.setSessionTestMode(TestMode(active = true, testTribeId = "kf1"))
        JvmFirestoreFixtures.kinfolk = listOf(household("active"))
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinfolkEditScreen(kinfolkId = "kf1", onBack = {}, onSaved = {}, onArchived = {})
            }
        }
        waitForIdle()
        onNodeWithText("Save changes").assertExists()
        assertTrue(onAllNodesWithText("Archive this Kinfolk").fetchSemanticsNodes().isEmpty())
        assertTrue(onAllNodesWithText("Archive").fetchSemanticsNodes().isEmpty())
    }
}
