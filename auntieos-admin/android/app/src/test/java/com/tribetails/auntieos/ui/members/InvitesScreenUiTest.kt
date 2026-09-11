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

    /**
     * The mock's shape (#755): the kit hero with the mock's kicker, no panel
     * around the sections, a section heading with the mono status note beside
     * it, and every invite one row with the address, the household, the
     * provenance line and the pills.
     */
    // A tall viewport so the whole list composes: LazyColumn only lays out
    // what fits, and this asserts on the second row.
    @Test
    @Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
    fun `draws the mock, hero kicker, bare section with its status note, and one row per invite`() {
        composeRule.setContent {
            AuntieOSTheme {
                InvitesBody(
                    viewModel = vmReturning(
                        listOf(
                            row(id = "i1", status = MembersRepository.InviteStatus.EMAIL_SENT),
                            row(id = "i2", household = "the Marlowes", tribeId = "f2"),
                        ),
                    ),
                    onOpenHousehold = { _, _ -> },
                )
            }
        }
        composeRule.waitForIdle()

        composeRule.onNodeWithText("THE DEN · INVITES").assertIsDisplayed()
        composeRule.onNodeWithText("Pending").assertIsDisplayed()
        composeRule.onNodeWithText("status: PENDING / EMAIL_SENT · 2").assertIsDisplayed()
        // The old wrapper panel and its title are gone; the sections sit on the ground.
        assertEquals(0, composeRule.onAllNodesWithText("Pending (2)").fetchSemanticsNodes().size)
        // One row per invite: address, household and provenance each their own node.
        assertEquals(2, composeRule.onAllNodesWithText("jane@example.com").fetchSemanticsNodes().size)
        composeRule.onNodeWithText("the Marlowes").assertIsDisplayed()
        composeRule.onNodeWithText("Sent 2026-08-01 · expires 2026-08-15 · inviteId i1").assertIsDisplayed()
        // The status pill in the mock's words, the role pill beside it.
        composeRule.onNodeWithText("EMAIL SENT").assertIsDisplayed()
        assertEquals(2, composeRule.onAllNodesWithText("PRIMARY").fetchSemanticsNodes().size)
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
