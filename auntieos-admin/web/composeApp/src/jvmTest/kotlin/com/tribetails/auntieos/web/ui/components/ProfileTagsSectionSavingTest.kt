package com.tribetails.auntieos.web.ui.components

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.observability.errorSink
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlinx.coroutines.CompletableDeferred
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #1271 on the desktop console: the tag save ran on a composition scope, so
 * leaving the screen (Back, Edit, any route change) right after removing a tag
 * cancelled the PATCH and the tag came back on the next read. Nothing on screen
 * said a save was out either, beyond a disabled field.
 *
 * These pin the three halves of the fix: the panel says "Saving…" and tells its
 * host (which holds Back) while a write is out; the write runs to its answer
 * even when the panel leaves composition mid-save; and the host is always told
 * the save settled, including when the save throws (and that a throw reverts
 * with a message and leaves the panel usable, rather than failing its scope).
 */
@OptIn(ExperimentalTestApi::class)
class ProfileTagsSectionSavingTest {

    private val defaultErrorSink = errorSink

    @AfterTest
    fun tearDown() {
        errorSink = defaultErrorSink
    }

    @Test
    fun showsSavingAndTellsTheHostWhileARemovalIsOutThenReleases() = runDesktopComposeUiTest {
        val gate = CompletableDeferred<Unit>()
        val savingSignals = mutableListOf<Boolean>()
        val sent = mutableListOf<List<String>>()

        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                ProfileTagsSection(
                    scope = TagScope.PET,
                    initialTags = listOf("Reactive", "On meds"),
                    client = FirestoreClient(),
                    onSaveTags = { next ->
                        sent += next
                        gate.await()
                        WriteResult.Ok(Unit)
                    },
                    onSavingChange = { savingSignals += it },
                )
            }
        }

        onNodeWithContentDescription("Remove On meds tag", useUnmergedTree = true).performClick()
        waitForIdle()

        assertEquals(listOf(listOf("Reactive")), sent)
        assertEquals(listOf(true), savingSignals)
        onNodeWithText("Saving…").assertExists()

        gate.complete(Unit)
        waitUntil(timeoutMillis = 10_000) { savingSignals.size == 2 }
        assertEquals(listOf(true, false), savingSignals)
        onNodeWithText("Saving…").assertDoesNotExist()
    }

    @Test
    fun leavingTheScreenMidSaveDoesNotCancelTheWrite() = runDesktopComposeUiTest {
        val gate = CompletableDeferred<Unit>()
        var written = false
        val savingSignals = mutableListOf<Boolean>()
        var shown by mutableStateOf(true)

        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                if (shown) {
                    ProfileTagsSection(
                        scope = TagScope.HOUSEHOLD,
                        initialTags = listOf("VIP"),
                        client = FirestoreClient(),
                        onSaveTags = {
                            gate.await()
                            written = true
                            WriteResult.Ok(Unit)
                        },
                        onSavingChange = { savingSignals += it },
                    )
                }
            }
        }

        onNodeWithContentDescription("Remove VIP tag", useUnmergedTree = true).performClick()
        waitForIdle()
        assertEquals(listOf(true), savingSignals)

        // The operator leaves: the panel's composition scope is cancelled.
        shown = false
        waitForIdle()

        // The server answers after the screen is gone. The write must still finish.
        gate.complete(Unit)
        waitUntil(timeoutMillis = 10_000) { written && savingSignals.size == 2 }
        assertTrue(written)
        assertEquals(listOf(true, false), savingSignals)
    }

    @Test
    fun aThrowingSaveStillReleasesTheHostAndPutsTheTagBack() = runDesktopComposeUiTest {
        val reported = mutableListOf<Throwable>()
        errorSink = { t, _ -> reported += t }
        val savingSignals = mutableListOf<Boolean>()

        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                ProfileTagsSection(
                    scope = TagScope.PET,
                    initialTags = listOf("vip"),
                    client = FirestoreClient(),
                    onSaveTags = { throw IllegalArgumentException("require failed") },
                    onSavingChange = { savingSignals += it },
                )
            }
        }

        onNodeWithContentDescription("Remove vip tag", useUnmergedTree = true).performClick()

        waitUntil(timeoutMillis = 10_000) { reported.isNotEmpty() && savingSignals.size == 2 }
        waitForIdle()
        assertEquals(listOf(true, false), savingSignals)
        onNodeWithText("Couldn't save tags: require failed", useUnmergedTree = true).assertExists()
        onNodeWithContentDescription("Remove vip tag", useUnmergedTree = true).assertExists()
        assertEquals(1, reported.size)
        assertTrue(reported.single() is IllegalArgumentException)
        // The panel is still alive: a second try runs a second save.
        onNodeWithContentDescription("Remove vip tag", useUnmergedTree = true).performClick()
        waitUntil(timeoutMillis = 10_000) { savingSignals.size == 4 }
        assertEquals(listOf(true, false, true, false), savingSignals)
    }
}
