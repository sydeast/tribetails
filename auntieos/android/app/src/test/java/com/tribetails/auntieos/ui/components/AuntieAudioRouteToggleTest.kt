package com.tribetails.auntieos.ui.components

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import com.tribetails.auntieos.voice.AudioRoute
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Interaction tests for AuntieAudioRouteToggle. Verifies:
 *  - tapping each available cell invokes onSelect with the correct route
 *  - the Bluetooth cell is disabled when BT not in `available`
 *  - the Bluetooth cell is enabled (and clickable) when BT is in `available`
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AuntieAudioRouteToggleTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun `tapping Speaker cell invokes onSelect with Speaker`() {
        var observed: AudioRoute? = null
        composeRule.setContent {
            AuntieOSTheme {
                AuntieAudioRouteToggle(
                    current = AudioRoute.Earpiece,
                    available = setOf(AudioRoute.Earpiece, AudioRoute.Speaker),
                    onSelect = { observed = it },
                )
            }
        }
        composeRule.onNodeWithText("Speaker").performClick()
        composeRule.waitForIdle()
        assertEquals(AudioRoute.Speaker, observed)
    }

    @Test
    fun `tapping Bluetooth cell invokes onSelect when BT available`() {
        var observed: AudioRoute? = null
        composeRule.setContent {
            AuntieOSTheme {
                AuntieAudioRouteToggle(
                    current = AudioRoute.Earpiece,
                    available = setOf(AudioRoute.Earpiece, AudioRoute.Speaker, AudioRoute.Bluetooth),
                    onSelect = { observed = it },
                )
            }
        }
        composeRule.onNodeWithText("Bluetooth").performClick()
        composeRule.waitForIdle()
        assertEquals(AudioRoute.Bluetooth, observed)
    }

    @Test
    fun `Bluetooth cell is disabled when BT not in available`() {
        var observed: AudioRoute? = null
        composeRule.setContent {
            AuntieOSTheme {
                AuntieAudioRouteToggle(
                    current = AudioRoute.Earpiece,
                    available = setOf(AudioRoute.Earpiece, AudioRoute.Speaker),
                    onSelect = { observed = it },
                )
            }
        }
        composeRule.onNodeWithText("Bluetooth").assertIsNotEnabled()
        composeRule.onNodeWithText("Bluetooth").performClick()
        composeRule.waitForIdle()
        assertEquals(null, observed)
    }

    @Test
    fun `Bluetooth cell is enabled when BT in available`() {
        composeRule.setContent {
            AuntieOSTheme {
                AuntieAudioRouteToggle(
                    current = AudioRoute.Earpiece,
                    available = setOf(AudioRoute.Earpiece, AudioRoute.Speaker, AudioRoute.Bluetooth),
                    onSelect = {},
                )
            }
        }
        composeRule.onNodeWithText("Bluetooth").assertIsEnabled()
    }
}
