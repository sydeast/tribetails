package com.tribetails.auntieos.web.screens.settings

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.AuthClient
import com.tribetails.auntieos.web.data.AuthUser
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import com.tribetails.auntieos.web.theme.ThemePersonalization
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #867 re-review: every visit to Settings started a business settings read, and
 * nothing stopped it when the operator left. On desktop that read is a polling loop,
 * so two visits left two loops. With no fixture the real polling read runs here (it
 * fails at the token check every poll and never ends by itself), which is what makes
 * the count meaningful: a fixture flow would finish at once and hide the leak.
 *
 * The count is compared against its value before the test, because view models the
 * commonTest suites build and never dispose share this JVM.
 */
@OptIn(ExperimentalTestApi::class)
class SettingsPollLeakRenderTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    @Test
    fun twoVisitsToSettingsLeaveOnePollingLoop() = runDesktopComposeUiTest {
        val before = SettingsViewModel.activeSettingsPolls.value
        var visible by mutableStateOf(true)
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                if (visible) {
                    SettingsScreen(
                        authUser = AuthUser(uid = "u1", email = "op@example.com"),
                        auth = AuthClient(),
                        themeMode = ThemeMode.DARK,
                        onThemeModeChange = {},
                        personalization = ThemePersonalization(),
                        onPersonalizationChange = {},
                    )
                }
            }
        }
        fun bannerShown() = onAllNodesWithText("Couldn't load business settings", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

        waitUntil(timeoutMillis = 10_000) { bannerShown() }
        assertEquals(before + 1, SettingsViewModel.activeSettingsPolls.value, "first visit")

        visible = false
        waitUntil(timeoutMillis = 10_000) { SettingsViewModel.activeSettingsPolls.value == before }

        visible = true
        waitUntil(timeoutMillis = 10_000) { bannerShown() }
        waitForIdle()
        assertEquals(before + 1, SettingsViewModel.activeSettingsPolls.value, "second visit")

        visible = false
        waitUntil(timeoutMillis = 10_000) { SettingsViewModel.activeSettingsPolls.value == before }
    }
}
