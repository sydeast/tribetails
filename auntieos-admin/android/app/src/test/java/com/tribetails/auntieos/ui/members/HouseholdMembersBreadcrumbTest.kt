package com.tribetails.auntieos.ui.members

import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertHasNoClickAction
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.data.repository.MembersRepository
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Item 7b on the one Android screen that had the defect the item is about.
 *
 * This screen headed itself "THE DEN · DIRECTORY", which is word for word what
 * `DirectoryScreen` two levels up says, so the kicker read identically on the
 * list and here. `ui-ideas/auntieos-members-2026-05-27.html` heads it
 * `Directory / Households / the Wrens / Members` instead.
 *
 * The two steps go to DIFFERENT places, and the reason is the back stack: a
 * bare `popBackStack()` lands on the household profile, so if the Directory
 * step shared it the operator would tap "Directory" and arrive at the Wrens.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w1080dp-h2400dp-xhdpi")
class HouseholdMembersBreadcrumbTest {

    @get:Rule
    val rule = createComposeRule()

    private lateinit var repo: MembersRepository

    @Before fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        repo = mockk()
        coEvery { repo.listMembers(any()) } returns Result.success(emptyList())
        coEvery { repo.listInvites(any()) } returns Result.success(emptyList())
    }

    @After fun tearDown() = Dispatchers.resetMain()

    private fun setContent(onBack: () -> Unit = {}, onDirectory: () -> Unit = {}) {
        rule.setContent {
            AuntieOSTheme {
                HouseholdMembersBody(
                    kinfolkName = "the Walls",
                    viewModel = HouseholdMembersViewModel(
                        kinfolkId = "fam1",
                        householdName = "the Walls",
                        repository = repo,
                    ),
                    onBack = onBack,
                    onDirectory = onDirectory,
                )
            }
        }
    }

    @Test
    fun the_kicker_is_gone_and_the_trail_stands_where_it_stood() {
        setContent()
        rule.onNodeWithText("THE DEN · DIRECTORY").assertDoesNotExist()
        rule.onNodeWithText("Directory").assertHasClickAction()
        // Since #755 the hero title is the household name too; the crumb is
        // the one that takes a tap.
        rule.onNode(hasText("the Walls") and hasClickAction()).assertHasClickAction()
        // The page you are on: named, and not tappable.
        rule.onNodeWithText("Members and invites").assertHasNoClickAction()
    }

    @Test
    fun the_two_steps_lead_to_two_different_places() {
        var wentBack = 0
        var wentToDirectory = 0
        setContent(onBack = { wentBack++ }, onDirectory = { wentToDirectory++ })

        rule.onNodeWithText("Directory").performClick()
        assertEquals(1, wentToDirectory)
        assertEquals(0, wentBack)

        rule.onNode(hasText("the Walls") and hasClickAction()).performClick()
        assertEquals(1, wentBack)
        assertEquals(1, wentToDirectory)
    }
}
