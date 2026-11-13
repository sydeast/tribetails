package com.tribetails.auntieos.web.screens.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.FakeAuntieDataSource
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * #2123: "KinTale required" in Settings > Visits and tracking on the console.
 * It reads OFF when the document has no key (ruling 2026-11-13), a save carries the operator's
 * choice, and the panel's other values are saved as they were loaded.
 */
@OptIn(ExperimentalTestApi::class)
class KinTaleRequiredToggleTest {

    private val switchRole = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Switch)

    /** The panel's switches in order: tracking, auto-start, photo tagging, arrival check, KinTale required, sharing. */
    private val kinTaleSwitch = 4

    private fun ComposeUiTest.show(loaded: BusinessSettings, saveFails: Boolean = false): FakeAuntieDataSource {
        val fake = FakeAuntieDataSource(saveShouldFail = saveFails, saveFailMessage = "KinTale required has to be on or off.")
        fake.emitBusinessSettings(FirestoreResult.Data(loaded))
        val vm = SettingsViewModel(fake)
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                // Scrollable, as Settings is: the Save button sits below a test window's fold.
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    VisitsTrackingPanel(settingsData = loaded, settingsLoaded = true, vm = vm, scope = rememberCoroutineScope())
                }
            }
        }
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText(KINTALE_REQUIRED_TITLE).fetchSemanticsNodes().isNotEmpty() }
        assertEquals(6, onAllNodes(switchRole).fetchSemanticsNodes().size)
        return fake
    }

    private fun ComposeUiTest.save() {
        onNodeWithText("Save visits and tracking").performScrollTo().performClick()
        waitForIdle()
    }

    @Test
    fun theRowAndItsWordsAreOnThePanel() = runDesktopComposeUiTest {
        show(BusinessSettings())
        onNodeWithText("KinTale required").assertExists()
        onNodeWithText(KINTALE_REQUIRED_DESCRIPTION).assertExists()
    }

    @Test
    fun aDocumentWithNoKeyShowsItOffAndTurningItOnSavesOn() = runDesktopComposeUiTest {
        // AuntieToggle carries no toggle state for the test to read; one tap saving
        // true is what shows the switch was off.
        val loaded = BusinessSettings(businessName = "Tribe Tails")
        val fake = show(loaded)
        onAllNodes(switchRole)[kinTaleSwitch].performScrollTo().performClick()
        save()
        waitUntil(timeoutMillis = 10_000) { fake.lastSavedBusinessSettings != null }
        assertEquals(loaded.copy(kinTaleRequired = true), fake.lastSavedBusinessSettings)
    }

    @Test
    fun turningItOffSavesItOffAndLeavesTheRestAsLoaded() = runDesktopComposeUiTest {
        val loaded = BusinessSettings(businessName = "Tribe Tails", requireArrivalDepartureVerification = true, kinTaleRequired = true)
        val fake = show(loaded)
        onAllNodes(switchRole)[kinTaleSwitch].performScrollTo().performClick()
        save()
        waitUntil(timeoutMillis = 10_000) { fake.lastSavedBusinessSettings != null }
        assertEquals(loaded.copy(kinTaleRequired = false), fake.lastSavedBusinessSettings)
    }

    @Test
    fun anOffSettingTurnedBackOnSavesOn() = runDesktopComposeUiTest {
        val loaded = BusinessSettings(kinTaleRequired = false)
        val fake = show(loaded)
        onAllNodes(switchRole)[kinTaleSwitch].performScrollTo().performClick()
        save()
        waitUntil(timeoutMillis = 10_000) { fake.lastSavedBusinessSettings != null }
        assertEquals(true, fake.lastSavedBusinessSettings?.kinTaleRequired)
    }

    @Test
    fun aSaveWithoutTouchingItKeepsWhatWasStored() = runDesktopComposeUiTest {
        val loaded = BusinessSettings(kinTaleRequired = false)
        val fake = show(loaded)
        save()
        waitUntil(timeoutMillis = 10_000) { fake.lastSavedBusinessSettings != null }
        assertEquals(false, fake.lastSavedBusinessSettings?.kinTaleRequired)
    }

    @Test
    fun aRefusedSaveSavesNothing() = runDesktopComposeUiTest {
        val fake = show(BusinessSettings(), saveFails = true)
        onAllNodes(switchRole)[kinTaleSwitch].performScrollTo().performClick()
        save()
        assertNull(fake.lastSavedBusinessSettings)
    }
}
