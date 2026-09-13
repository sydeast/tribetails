package com.tribetails.auntieos.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #780: the Android half of the hero slots, mirroring the `DenScreenHeading`
 * block of `src/components/DenScreenKit.test.tsx`.
 *
 * Four of the seven 2026-09-11 sweeps finished their screen and reported the
 * same gap: the kit heading had nowhere to put the mock's hero photo, its
 * owner line or its tag row, and on Android it painted no band at all. The
 * band itself is paint and is checked by eye; what a test can hold is that
 * each slot renders where it is given, renders nothing where it is not, and
 * that a heading passing none of them still composes exactly as before.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DenHeroSlotsTest {

    @get:Rule
    val rule = createComposeRule()

    private fun isHeading() = SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading)

    @Test
    fun `the leading, content and badges slots all render inside the heading`() {
        rule.setContent {
            AuntieOSTheme {
                DenScreenHeading(
                    kicker = "The Den · Directory",
                    crumbs = listOf(DenCrumb("Directory") {}, DenCrumb("the Wrens") {}),
                    title = "Biscuit",
                    detail = "Labrador Retriever · 5 yrs",
                    leading = { Text("B") },
                    badges = {
                        AuntieStatusPill(label = "Yellow lab", tone = AuntieStatusTone.Neutral, mono = true)
                        AuntieStatusPill(label = "Microchipped", tone = AuntieStatusTone.Neutral, mono = true)
                    },
                    content = { Text("belongs to the Wrens") },
                )
            }
        }

        rule.onNodeWithText("Biscuit").assertIsDisplayed()
        rule.onNodeWithText("Labrador Retriever · 5 yrs").assertIsDisplayed()
        rule.onNodeWithText("belongs to the Wrens").assertIsDisplayed()
        rule.onNodeWithText("YELLOW LAB").assertIsDisplayed()
        rule.onNodeWithText("MICROCHIPPED").assertIsDisplayed()
        // The trail rides inside the band, where the kin detail's already does.
        rule.onNodeWithText("Directory").assertHasClickAction()
    }

    @Test
    fun `a heading with no slots composes exactly as it did before`() {
        rule.setContent {
            AuntieOSTheme {
                DenScreenHeading(kicker = "The Den · Schedule", title = "Schedule", accentTail = "week.")
            }
        }

        rule.onNodeWithText("THE DEN · SCHEDULE").assertIsDisplayed()
        rule.onNodeWithText("week.").assertIsDisplayed()
    }

    /**
     * The action row is the mock's `.actions`. Beside the title on a list
     * screen; under the title block on a profile band (one with a [leading]),
     * where the mocks' own phone-width rule sends it. Either way it renders
     * and its buttons fire.
     */
    @Test
    fun `trailing renders and fires with and without a leading slot`() {
        var fired = 0
        rule.setContent {
            AuntieOSTheme {
                Column {
                    DenScreenHeading(
                        kicker = "The Den · Directory",
                        title = "Your",
                        accentTail = "kinfolk",
                        trailing = { GhostButton(label = "Add kinfolk", onClick = { fired++ }) },
                    )
                    DenScreenHeading(
                        kicker = "The Den · Directory",
                        crumbs = listOf(DenCrumb("Directory") {}, DenCrumb("Lorna Wren")),
                        title = "Lorna Wren",
                        leading = { Text("LW") },
                        trailing = { GhostButton(label = "Edit", onClick = { fired += 10 }) },
                    )
                }
            }
        }

        rule.onNodeWithText("Add kinfolk").performClick()
        rule.onNodeWithText("Edit").performClick()
        assertEquals(11, fired)
    }

    @Test
    fun `the panel meta note renders beside the title and stays out of the heading`() {
        rule.setContent {
            AuntieOSTheme {
                DenPanel(title = "Kin", meta = "2 kin") {}
            }
        }

        rule.onNodeWithText("2 kin").assertIsDisplayed()
        // The count is a note about the panel, not part of its name.
        rule.onNode(isHeading() and hasText("2 kin")).assertDoesNotExist()
        rule.onNode(isHeading() and hasText("Kin")).assertIsDisplayed()
    }

    @Test
    fun `a blank panel meta renders nothing`() {
        rule.setContent {
            AuntieOSTheme {
                DenPanel(title = "Kin", meta = "   ") {}
            }
        }

        rule.onNodeWithText("   ").assertDoesNotExist()
        rule.onNodeWithText("Kin").assertIsDisplayed()
    }

    @Test
    fun `a compact status pill keeps its label and tone`() {
        rule.setContent {
            AuntieOSTheme {
                AuntieStatusPill(label = "archived", tone = AuntieStatusTone.Warning, mono = true, compact = true)
            }
        }

        rule.onNodeWithText("ARCHIVED").assertIsDisplayed()
    }

    @Test
    fun `the info tip still rides the band`() {
        rule.setContent {
            AuntieOSTheme {
                DenScreenHeading(
                    kicker = "The Den · Auntie Time",
                    title = "Auntie Time",
                    subtitle = "Day-of view.",
                    leading = { Text("A") },
                )
            }
        }

        rule.onNodeWithContentDescription("Day-of view.").assertIsDisplayed()
    }
}
