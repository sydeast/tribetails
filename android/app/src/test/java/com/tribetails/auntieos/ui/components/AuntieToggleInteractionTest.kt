package com.tribetails.auntieos.ui.components

import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Pilot Compose UI interaction test. Proves Robolectric + Compose UI test infra
 * works at unit-test scope (not androidTest), unblocking real interaction tests
 * for primitives whose decision logic isn't extractable to a pure helper.
 *
 * Behavior verified: AuntieToggle invokes onCheckedChange with the inverted
 * boolean on click; disabled toggles do not invoke the callback.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AuntieToggleInteractionTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun `click invokes onCheckedChange with inverted boolean`() {
        var observed: Boolean? = null
        composeRule.setContent {
            AuntieOSTheme {
                var checked by remember { mutableStateOf(false) }
                AuntieToggle(
                    checked = checked,
                    onCheckedChange = {
                        observed = it
                        checked = it
                    },
                )
            }
        }

        composeRule.onNode(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Switch))
            .performClick()
        composeRule.waitForIdle()

        assertEquals(true, observed)
    }

    @Test
    fun `disabled toggle does not invoke onCheckedChange on click`() {
        var observed: Boolean? = null
        composeRule.setContent {
            AuntieOSTheme {
                AuntieToggle(
                    checked = false,
                    onCheckedChange = { observed = it },
                    enabled = false,
                )
            }
        }

        composeRule.onNode(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Switch))
            .performClick()
        composeRule.waitForIdle()

        assertEquals(null, observed)
    }
}
