package com.tribetails.auntieos.ui.members

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
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
 * [InvitesScreen], the two claims that are about the RULING rather than layout.
 *
 * RULING: the admin never mints a SECONDARY invite, and a PRIMARY's
 * entitlements are inherent to the role and cannot be toggled by anybody. This
 * screen is admin-WIDE, so it additionally has no household to mint into or act
 * on. It has been rebuilt wrong more than once, in both directions, so the
 * absence of those controls is asserted rather than assumed.
 *
 * And FAIL LOUD: a failed read must show the failure, never the empty state.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class InvitesScreenUiTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private fun row(
        id: String = "rq_8fk29aLONGTAIL",
        household: String = "the Demos",
        tribeId: String = "f1",
        status: MembersRepository.InviteStatus = MembersRepository.InviteStatus.PENDING,
    ) = MembersRepository.AdminInvite(
        invite = MembersRepository.Invite(
            inviteId = id,
            invitedEmail = "jane@example.com",
            secondaryLabel = null,
            proposedRole = MembersRepository.MemberRole.PRIMARY,
            status = status,
            effectiveStatus = status,
            redeemable = status == MembersRepository.InviteStatus.PENDING,
            createdAt = "2026-08-01T00:00:00.000Z",
            sentToInviteeAt = "2026-08-01T00:01:00.000Z",
            expiresAt = "2026-08-15T00:00:00.000Z",
            revokedAt = null,
        ),
        tribeId = tribeId,
        householdName = household,
    )

    private fun vmReturning(rows: List<MembersRepository.AdminInvite>): InvitesViewModel {
        val repo = mockk<MembersRepository>()
        coEvery { repo.listAllInvites() } returns Result.success(rows)
        return InvitesViewModel(repository = repo)
    }

    @Test
    fun `offers no send, no revoke, and never renders the full invite id`() {
        composeRule.setContent {
            AuntieOSTheme {
                InvitesBody(viewModel = vmReturning(listOf(row())), onOpenHousehold = { _, _ -> })
            }
        }
        composeRule.waitForIdle()

        composeRule.onNodeWithText("the Demos").assertIsDisplayed()
        // Every action lives on the household's own screen. A control here would
        // have no household to act on even if the ruling allowed one.
        for (label in listOf("Invite a primary", "Send", "Revoke", "Resend")) {
            assertEquals(
                "InvitesScreen must not offer \"$label\"",
                0,
                composeRule.onAllNodesWithText(label).fetchSemanticsNodes().size,
            )
        }
        // The invite id IS the claim-link bearer token: the truncated handle
        // shows, the full id never does.
        assertTrue(
            composeRule.onAllNodesWithText("rq_8fk29aLONGTAIL", substring = true)
                .fetchSemanticsNodes().isEmpty(),
        )
    }

    @Test
    fun `tapping a row opens that household, carrying its id and name`() {
        var opened: Pair<String, String>? = null
        composeRule.setContent {
            AuntieOSTheme {
                InvitesBody(
                    viewModel = vmReturning(listOf(row(tribeId = "fam_77"))),
                    onOpenHousehold = { id, name -> opened = id to name },
                )
            }
        }
        composeRule.waitForIdle()

        composeRule.onNodeWithText("the Demos").performClick()
        composeRule.waitForIdle()

        assertEquals("fam_77" to "the Demos", opened)
    }

    /** "Nobody was invited" and "we could not find out" are opposite facts. */
    @Test
    fun `a failed read shows the failure, never the empty state`() {
        val repo = mockk<MembersRepository>()
        coEvery { repo.listAllInvites() } returns Result.failure(Exception("permission-denied"))
        composeRule.setContent {
            AuntieOSTheme {
                InvitesBody(viewModel = InvitesViewModel(repository = repo), onOpenHousehold = { _, _ -> })
            }
        }
        composeRule.waitForIdle()

        composeRule.onNodeWithText("listAllInvites failed", substring = true).assertIsDisplayed()
        assertEquals(
            0,
            composeRule.onAllNodesWithText("No invites have been sent from any household yet.")
                .fetchSemanticsNodes().size,
        )
    }
}
