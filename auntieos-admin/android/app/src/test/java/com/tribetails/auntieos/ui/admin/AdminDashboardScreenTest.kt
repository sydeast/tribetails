package com.tribetails.auntieos.ui.admin

import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToNode
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Rule
import org.junit.Test
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.junit.runner.RunWith

/**
 * Operator ruling 2026-09-12: Marketing blasts is communication, so it moved
 * off this dashboard onto Communicate (`ui/communicate/CommunicateScreen.kt`).
 *
 * The dashboard's `LazyColumn` only composes what is in the test viewport, so
 * asserting the tile's text `.assertDoesNotExist()` cold would pass whether or
 * not the tile was ever removed - it would never have been composed either
 * way. This scrolls PAST where the tile used to sit (between Templates and
 * Feature Flags) before asserting its absence, so the assertion actually
 * exercises the removal.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AdminDashboardScreenTest {

    @get:Rule
    val rule = createComposeRule()

    private fun render() {
        rule.setContent {
            AuntieOSTheme {
                AdminDashboardScreen(
                    onNavigateToSchedule = {},
                    onNavigateToSettings = {},
                    onNavigateToLogs = {},
                )
            }
        }
    }

    @Test
    fun `Templates and Feature Flags are still adjacent, with no Marketing Blasts tile between them`() {
        render()

        // Force composition through the removed tile's old slot.
        rule.onNodeWithTag("admin-dashboard-list")
            .performScrollToNode(hasText("Feature Flags"))

        rule.onNodeWithText("Templates").assertExists()
        rule.onNodeWithText("Feature Flags").assertExists()
        rule.onNodeWithText("Marketing Blasts").assertDoesNotExist()
    }
}
