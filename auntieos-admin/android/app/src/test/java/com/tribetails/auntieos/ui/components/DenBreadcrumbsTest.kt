package com.tribetails.auntieos.ui.components

import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.junit4.createComposeRule
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
 * The Android half of item 7b, mirroring `src/components/DenScreenKit.test.tsx`.
 *
 * The complaint is the same on both platforms: `HouseholdMembersScreen` headed
 * itself "THE DEN · DIRECTORY", which is word for word what `DirectoryScreen`
 * two levels up says, so the kicker could not tell an operator which of the two
 * they were looking at. On a nested screen the trail replaces it.
 *
 * Compose has no `<nav>` and no `aria-current`, so the web contract lands here
 * as CLICKABILITY: every step you can go to is clickable, and the step you are
 * already on is not. A tappable crumb for the current page is the same lie in
 * either language.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class DenBreadcrumbsTest {

    @get:Rule
    val rule = createComposeRule()

    @Test
    fun the_current_page_is_the_only_step_you_cannot_tap() {
        rule.setContent {
            AuntieOSTheme {
                DenBreadcrumbs(
                    crumbs = listOf(
                        DenCrumb("Directory") {},
                        DenCrumb("the Wrens") {},
                        DenCrumb("Members and invites"),
                    ),
                )
            }
        }

        rule.onNodeWithText("Directory").assertHasClickAction()
        rule.onNodeWithText("the Wrens").assertHasClickAction()
        rule.onNodeWithText("Members and invites").assertHasNoClickAction()
    }

    @Test
    fun tapping_a_step_walks_back_to_it() {
        var walkedTo: String? = null
        rule.setContent {
            AuntieOSTheme {
                DenBreadcrumbs(
                    crumbs = listOf(
                        DenCrumb("Directory") { walkedTo = "Directory" },
                        DenCrumb("the Wrens") { walkedTo = "the Wrens" },
                        DenCrumb("Members and invites"),
                    ),
                )
            }
        }

        rule.onNodeWithText("the Wrens").performClick()
        assertEquals("the Wrens", walkedTo)
    }

    /**
     * The heading carries EITHER a kicker or a trail, never both: the ten
     * `.crumbs` mocks all put the trail exactly where a list screen puts its
     * kicker, and not one of them shows the two together.
     */
    @Test
    fun a_heading_with_crumbs_drops_the_kicker() {
        rule.setContent {
            AuntieOSTheme {
                DenScreenHeading(
                    kicker = "The Den · Directory",
                    crumbs = listOf(DenCrumb("Directory") {}, DenCrumb("the Wrens")),
                    title = "Members and",
                    accentTail = "invites.",
                )
            }
        }

        rule.onNodeWithText("THE DEN · DIRECTORY").assertDoesNotExist()
        rule.onNodeWithText("Directory").assertHasClickAction()
    }

    @Test
    fun a_heading_without_crumbs_still_shows_its_kicker() {
        rule.setContent {
            AuntieOSTheme {
                DenScreenHeading(kicker = "The Den · Directory", title = "Your", accentTail = "kinfolk")
            }
        }

        rule.onNodeWithText("THE DEN · DIRECTORY").assertExists()
    }

    /**
     * The separator is decoration and must not be spoken: TalkBack reading
     * "Directory slash the Wrens slash Members and invites" turns three
     * destinations into one sentence.
     */
    @Test
    fun the_separator_is_not_part_of_any_step() {
        assertEquals(2, crumbSeparatorCount(3))
        assertEquals(0, crumbSeparatorCount(1))
        assertEquals(0, crumbSeparatorCount(0))
    }
}
