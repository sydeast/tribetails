package com.tribetails.auntieos.web.screens.directory

import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test

/**
 * #898: [KinfolkEditScreen]'s `getHouseholdData` read used to drop a
 * [WriteResult.Err] on the floor, leaving this box's "Loading household data…"
 * text showing forever with nothing telling the operator the read had failed.
 * Exercised directly (not through the edit screen) because the screen's own
 * dossier read has no test fixture and always fails in a jvm test, so the box
 * never renders there.
 */
@OptIn(ExperimentalTestApi::class)
class HouseholdNotesMigrationBoxRenderTest {

    @Test
    fun aFailedHouseholdReadShowsAnErrorNotAnEndlessLoadingLine() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                val scope = rememberCoroutineScope()
                HouseholdNotesMigrationBox(
                    notes = "Side gate code is 4321.",
                    household = null,
                    onClear = { WriteResult.Ok(Unit) },
                    scope = scope,
                    householdError = "Not signed in",
                )
            }
        }
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText("Couldn't load household data", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        assert(onAllNodesWithText("Loading household data…", useUnmergedTree = true).fetchSemanticsNodes().isEmpty()) {
            "a failed read must not still claim to be loading"
        }
    }

    @Test
    fun aNullHouseholdWithNoErrorStillReadsAsLoading() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                val scope = rememberCoroutineScope()
                HouseholdNotesMigrationBox(
                    notes = "Side gate code is 4321.",
                    household = null,
                    onClear = { WriteResult.Ok(Unit) },
                    scope = scope,
                )
            }
        }
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText("Loading household data…", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
    }
}
