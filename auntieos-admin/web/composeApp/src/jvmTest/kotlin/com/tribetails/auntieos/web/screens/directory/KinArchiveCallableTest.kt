package com.tribetails.auntieos.web.screens.directory
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.WriteResult
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
 * #1501: the Kin view's Archive and Restore go through the owner-only
 * `setKinArchived` callable (the way admin web and Android do), never a direct
 * write of `status` on the flat `kin/{id}` doc. The jvm callable answers from
 * [JvmFirestoreFixtures.callableResponses] and records the name and payload; any
 * direct write would land in `lastWrite`, which stays null.
 */
@OptIn(ExperimentalTestApi::class)
class KinArchiveCallableTest {
    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()
    private fun payload() = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject
    @Test
    fun archiveCallsTheCallableWithTheFlatIdAndArchivedTrue() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("setKinArchived" to """{"ok":true,"archived":true,"flatStatus":"archived"}""")
        val r = FirestoreClient().setKinArchived(" k1 ", true)
        assertTrue(r is WriteResult.Ok)
        assertEquals("setKinArchived", JvmFirestoreFixtures.lastCallableName)
        assertEquals("k1", payload()["kinId"]?.jsonPrimitive?.content)
        assertEquals(true, payload()["archived"]?.jsonPrimitive?.booleanOrNull)
        assertNull(JvmFirestoreFixtures.lastWrite)
    }
    @Test
    fun restoreCallsTheSameCallableWithArchivedFalse() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("setKinArchived" to """{"ok":true,"archived":false,"flatStatus":"active"}""")
        val r = FirestoreClient().setKinArchived("k1", false)
        assertTrue(r is WriteResult.Ok)
        assertEquals("setKinArchived", JvmFirestoreFixtures.lastCallableName)
        assertEquals(false, payload()["archived"]?.jsonPrimitive?.booleanOrNull)
        assertNull(JvmFirestoreFixtures.lastWrite)
    }
    @Test
    fun aRefusalComesBackAsTheErrMessage() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("setKinArchived" to "Only the owner can archive a Kin.")
        val r = FirestoreClient().setKinArchived("k1", true)
        assertEquals("Only the owner can archive a Kin.", (r as WriteResult.Err).message)
    }
    @Test
    fun aBlankIdNeverReachesTheServer() = runBlocking {
        val r = FirestoreClient().setKinArchived("  ", true)
        assertTrue(r is WriteResult.Err)
        assertNull(JvmFirestoreFixtures.lastCallableName)
    }
    private fun kin(status: String) = Kin(_id = "k1", kinfolkId = "kf1", name = "Willow", status = status)
    private fun noCustomFields() {
        JvmFirestoreFixtures.callableResponses = mapOf("listFormSchemas" to """{"schemas":[]}""")
    }
    @Test
    fun theArchiveButtonCallsTheCallableAndLeavesTheScreen() = runDesktopComposeUiTest {
        noCustomFields()
        JvmFirestoreFixtures.callableResponses += mapOf("setKinArchived" to """{"ok":true,"archived":true,"flatStatus":"archived"}""")
        JvmFirestoreFixtures.kinByKinfolk = mapOf("kf1" to listOf(kin("active")))
        var archivedCalled = false
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinEditScreen(kinfolkId = "kf1", kinId = "k1", onBack = {}, onSaved = {}, onArchived = { archivedCalled = true })
            }
        }
        waitForIdle()
        onNodeWithText("Archive").performScrollTo().performClick()
        waitUntil(timeoutMillis = 5_000) { archivedCalled }
        assertEquals("setKinArchived", JvmFirestoreFixtures.lastCallableName)
        assertEquals(true, payload()["archived"]?.jsonPrimitive?.booleanOrNull)
        assertNull(JvmFirestoreFixtures.lastWrite)
    }
    @Test
    fun anArchivedKinOffersRestoreAndRestoreCallsTheCallable() = runDesktopComposeUiTest {
        noCustomFields()
        JvmFirestoreFixtures.callableResponses += mapOf("setKinArchived" to """{"ok":true,"archived":false,"flatStatus":"active"}""")
        JvmFirestoreFixtures.kinByKinfolk = mapOf("kf1" to listOf(kin("archived")))
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinEditScreen(kinfolkId = "kf1", kinId = "k1", onBack = {}, onSaved = {}, onArchived = {})
            }
        }
        waitForIdle()
        onNodeWithText("Restore").performScrollTo().performClick()
        waitUntil(timeoutMillis = 5_000) { JvmFirestoreFixtures.lastCallableName == "setKinArchived" }
        assertEquals(false, payload()["archived"]?.jsonPrimitive?.booleanOrNull)
        // The block follows at once: the Kin is active again, so Archive is offered.
        waitUntil(timeoutMillis = 5_000) {
            onAllNodesWithTextCount("Archive") > 0
        }
        assertNull(JvmFirestoreFixtures.lastWrite)
    }
    @Test
    fun anAuntiesRefusalShowsInlineAndTheScreenStays() = runDesktopComposeUiTest {
        noCustomFields()
        JvmFirestoreFixtures.callableErrors = mapOf("setKinArchived" to "Only the owner can archive a Kin.")
        JvmFirestoreFixtures.kinByKinfolk = mapOf("kf1" to listOf(kin("active")))
        var archivedCalled = false
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinEditScreen(kinfolkId = "kf1", kinId = "k1", onBack = {}, onSaved = {}, onArchived = { archivedCalled = true })
            }
        }
        waitForIdle()
        onNodeWithText("Archive").performScrollTo().performClick()
        waitUntil(timeoutMillis = 5_000) { JvmFirestoreFixtures.lastCallableName == "setKinArchived" }
        waitForIdle()
        onNodeWithText("Only the owner can archive a Kin.").assertExists()
        assertTrue(!archivedCalled)
        // The button is back for a retry.
        onNodeWithText("Archive").assertExists()
    }
    private fun androidx.compose.ui.test.ComposeUiTest.onAllNodesWithTextCount(t: String): Int =
        onAllNodesWithText(t).fetchSemanticsNodes().size
}
