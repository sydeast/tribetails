package com.tribetails.auntieos.ui.members

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.hasScrollAction
import com.tribetails.auntieos.data.repository.MembersRepository
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.mockk
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * [InviteDetailScreen] (#1339): it shows the invite, offers the household's
 * own screen as its one action, never a second Revoke, never the full id, and
 * a failed read shows the failure rather than an empty page.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h2000dp")
class InviteDetailScreenUiTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private fun vm(result: Result<MembersRepository.InviteDetail>): InviteDetailViewModel {
        val repo = mockk<MembersRepository>()
        coEvery { repo.getInvite("rq_8fk29aLONGTAIL") } returns result
        return InviteDetailViewModel("rq_8fk29aLONGTAIL", repo)
    }

    @Test
    fun `shows who invited whom and offers only the household screen as its action`() {
        var opened: Pair<String, String>? = null
        composeRule.setContent {
            AuntieOSTheme {
                InviteDetailBody(
                    viewModel = vm(Result.success(inviteDetail())),
                    onInvites = {},
                    onOpenHousehold = { id, name -> opened = id to name },
                )
            }
        }
        composeRule.waitForIdle()

        composeRule.onNodeWithText("Dora Demo (dora@example.com), household primary").assertIsDisplayed()
        composeRule.onNodeWithText("Not claimed").assertIsDisplayed()
        assertEquals(0, composeRule.onAllNodesWithText("Revoke").fetchSemanticsNodes().size)
        // The invite id IS the claim token: the handle shows, the full id never.
        assertTrue(
            composeRule.onAllNodesWithText("rq_8fk29aLONGTAIL", substring = true)
                .fetchSemanticsNodes().isEmpty(),
        )
        composeRule.onNode(hasScrollAction())
            .performScrollToNode(hasText("Open the Demos's members and invites"))
        composeRule.onNodeWithText("Open the Demos's members and invites").performClick()
        composeRule.waitForIdle()
        assertEquals("fam_77" to "the Demos", opened)
    }

    @Test
    fun `a failed read shows the failure and a retry, never an empty invite`() {
        composeRule.setContent {
            AuntieOSTheme {
                InviteDetailBody(
                    viewModel = vm(Result.failure(IllegalStateException("No invite with that id."))),
                    onInvites = {},
                    onOpenHousehold = { _, _ -> },
                )
            }
        }
        composeRule.waitForIdle()

        composeRule.onNodeWithText("getInvite failed: No invite with that id.").assertIsDisplayed()
        composeRule.onNodeWithText("Retry").assertIsDisplayed()
        assertEquals(0, composeRule.onAllNodesWithText("Not claimed").fetchSemanticsNodes().size)
    }
}
