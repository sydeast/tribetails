package com.tribetails.auntieos.web.screens

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.screens.directory.KinEditScreen
import com.tribetails.auntieos.web.screens.directory.KinfolkEditScreen
import com.tribetails.auntieos.web.screens.directory.KinfolkProfileScreen
import com.tribetails.auntieos.web.screens.kintales.KinTaleComposeScreen
import com.tribetails.auntieos.web.screens.sessions.KinCareDetailScreen
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import com.tribetails.auntieos.web.ui.components.NOT_FOUND_TAG
import kotlin.test.AfterTest
import kotlin.test.Test

/**
 * #898 "Other": the edit, profile and detail screens answered a read that does
 * not contain the id they were opened with (a deleted record, or a stale link)
 * by shimmering forever, the same as still-loading. Each test seeds the
 * underlying stream with a fixture that does NOT contain the target id, so the
 * read answers (FirestoreResult.Data) but the lookup misses, and asserts the
 * screen shows a not-found notice instead of an endless shimmer.
 */
@OptIn(ExperimentalTestApi::class)
class DesktopNotFoundRenderTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private fun androidx.compose.ui.test.ComposeUiTest.assertNotFoundShows(message: String) {
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithTag(NOT_FOUND_TAG, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        assert(onAllNodesWithText(message, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()) { "expected: $message" }
    }

    @Test
    fun kinfolkEditScreenShowsNotFoundForADeletedHousehold() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.kinfolk = listOf(Kinfolk(_id = "kf-other"))
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinfolkEditScreen(kinfolkId = "kf-missing", onBack = {}, onSaved = {}, onArchived = {})
            }
        }
        assertNotFoundShows("This household couldn't be found. It may have been removed.")
    }

    @Test
    fun kinEditScreenShowsNotFoundForADeletedKin() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.kinByKinfolk = mapOf("kf1" to listOf(Kin(_id = "k-other", kinfolkId = "kf1", name = "Biscuit")))
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinEditScreen(kinfolkId = "kf1", kinId = "k-missing", onBack = {}, onSaved = {}, onArchived = {})
            }
        }
        assertNotFoundShows("This kin couldn't be found. It may have been removed.")
    }

    @Test
    fun kinfolkProfileScreenShowsNotFoundForADeletedHousehold() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.kinfolk = listOf(Kinfolk(_id = "kf-other"))
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinfolkProfileScreen(kinfolkId = "kf-missing", onBack = {}, onEdit = {}, onAddKin = {}, onViewKin = {})
            }
        }
        assertNotFoundShows("This household couldn't be found. It may have been removed.")
    }

    @Test
    fun kinCareDetailScreenShowsNotFoundForADeletedSession() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.sessions = listOf(KinCareSession(_id = "s-other"))
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinCareDetailScreen(kinCareId = "s-missing", onBack = {})
            }
        }
        assertNotFoundShows("This Kin Care couldn't be found. It may have been removed.")
    }

    @Test
    fun kinTaleComposeScreenShowsNotFoundForADeletedSession() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.sessions = listOf(KinCareSession(_id = "s-other"))
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                KinTaleComposeScreen(sessionId = "s-missing", onClose = {})
            }
        }
        assertNotFoundShows("This Kin Care couldn't be found. It may have been removed.")
    }
}
