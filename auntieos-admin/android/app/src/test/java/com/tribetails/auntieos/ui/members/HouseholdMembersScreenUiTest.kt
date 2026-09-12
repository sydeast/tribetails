package com.tribetails.auntieos.ui.members

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import com.tribetails.auntieos.data.repository.MembersRepository
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.mockk
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * [HouseholdMembersScreen] laid out as `ui-ideas/auntieos-members-2026-05-27.html`
 * draws it (#755, checklist line Members): the hero names the household and
 * carries the mono where line, the roster is split by role into Primary
 * contact and Secondary contacts with the mock's notes, a primary carries the
 * "granted by role" capsule and no switch, a secondary carries the permission
 * list with the Locked on chip. And the rulings that have been rebuilt wrong
 * before: no add-secondary control, no switch on a primary.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class HouseholdMembersScreenUiTest {

    @get:Rule
    val composeRule = createAndroidComposeRule<ComponentActivity>()

    private fun member(
        uid: String,
        role: MembersRepository.MemberRole,
        email: String,
        label: String? = null,
        status: MembersRepository.MemberStatus = MembersRepository.MemberStatus.ACTIVE,
    ) = MembersRepository.Member(
        uid = uid,
        secondaryLabel = label,
        role = role,
        status = status,
        permissions = MembersRepository.MemberPermissions(messagingDirect = true, kintalesOnly = true),
        invitedEmail = email,
    )

    private fun setContent(members: List<MembersRepository.Member>) {
        val repo = mockk<MembersRepository>()
        coEvery { repo.listMembers("fam1") } returns Result.success(members)
        coEvery { repo.listInvites("fam1") } returns Result.success(emptyList())
        composeRule.setContent {
            AuntieOSTheme {
                HouseholdMembersBody(
                    kinfolkName = "the Walls",
                    viewModel = HouseholdMembersViewModel(
                        kinfolkId = "fam1",
                        householdName = "the Walls",
                        repository = repo,
                    ),
                )
            }
        }
        composeRule.waitForIdle()
    }

    @Test
    fun `draws the mock, the household hero with its where line and the roster split by role`() {
        setContent(
            listOf(
                member("p1", MembersRepository.MemberRole.PRIMARY, "lost@example.com"),
                member("u1", MembersRepository.MemberRole.SECONDARY, "marcus@example.com", label = "Spouse"),
            ),
        )

        // The hero: the household name as the title (the crumb of the same
        // name is the tappable one), and the mock's mono line under it.
        assertEquals(2, composeRule.onAllNodesWithText("the Walls").fetchSemanticsNodes().size)
        assertEquals(1, composeRule.onAllNodes(hasText("the Walls") and hasClickAction()).fetchSemanticsNodes().size)
        composeRule.onNodeWithText("familyId: fam1 · 2 members · 1 PRIMARY, 1 SECONDARY").assertIsDisplayed()
        composeRule.onNodeWithText("THE DEN · DIRECTORY").assertDoesNotExist()

        // The panels and their notes, in the mock's order.
        composeRule.onNodeWithText("Primary contact").assertIsDisplayed()
        composeRule.onNodeWithText("role: PRIMARY").assertIsDisplayed()
        composeRule.onNodeWithText("Secondary contacts").assertIsDisplayed()
        composeRule.onNodeWithText("1 of role: SECONDARY").assertIsDisplayed()
        composeRule.onNodeWithText("Invites").assertIsDisplayed()
        // The old single Members panel and its "on file" pill are gone.
        assertEquals(0, composeRule.onAllNodesWithText("2 on file").fetchSemanticsNodes().size)

        // Each member: the name, the compact role and status capsules, the uid.
        composeRule.onNodeWithText("lost@example.com").assertIsDisplayed()
        composeRule.onNodeWithText("marcus@example.com").assertIsDisplayed()
        composeRule.onNodeWithText("PRIMARY").assertIsDisplayed()
        composeRule.onNodeWithText("SECONDARY").assertIsDisplayed()
        assertEquals(2, composeRule.onAllNodesWithText("ACTIVE").fetchSemanticsNodes().size)
        composeRule.onNodeWithText("u1").assertIsDisplayed()
        // The secondary's label, read-only, in the mock's shape.
        composeRule.onNodeWithText("SECONDARYLABEL").assertIsDisplayed()
        composeRule.onNodeWithText("Spouse").assertIsDisplayed()
    }

    @Test
    fun `a primary carries the granted-by-role capsule and no switch, a secondary the list with Locked on`() {
        setContent(
            listOf(
                member("p1", MembersRepository.MemberRole.PRIMARY, "lost@example.com"),
                member("u1", MembersRepository.MemberRole.SECONDARY, "marcus@example.com"),
            ),
        )

        composeRule.onNodeWithText("ALL PERMISSIONS GRANTED BY ROLE").assertIsDisplayed()
        assertEquals(0, composeRule.onAllNodesWithText("GRANTED").fetchSemanticsNodes().size)
        // One permission list on the page, the secondary's: the kicker once,
        // the lock chip once, every row label once.
        assertEquals(1, composeRule.onAllNodesWithText("PERMISSIONS").fetchSemanticsNodes().size)
        assertEquals(1, composeRule.onAllNodesWithText("LOCKED ON").fetchSemanticsNodes().size)
        PERMISSION_ROWS.forEach { row ->
            assertEquals(row.label, 1, composeRule.onAllNodesWithText(row.label).fetchSemanticsNodes().size)
        }
    }

    @Test
    fun `offers none of the mock controls the admin cannot use`() {
        setContent(listOf(member("u1", MembersRepository.MemberRole.SECONDARY, "marcus@example.com")))

        for (label in listOf("Add secondary contact", "Save label", "Swap contact info", "Invite a primary")) {
            assertEquals(
                "HouseholdMembersScreen must not offer \"$label\"",
                0,
                composeRule.onAllNodesWithText(label, substring = true).fetchSemanticsNodes().size,
            )
        }
        // No primary on the roster: the Primary contact panel says so, and
        // the secondary still renders in its own panel.
        composeRule.onNodeWithText("There is no active primary", substring = true).assertIsDisplayed()
        composeRule.onNodeWithText("marcus@example.com").assertIsDisplayed()
    }

    /** "Nobody is here" and "we could not find out" are opposite facts. */
    @Test
    fun `a failed read names the failure once and shows no empty state`() {
        val repo = mockk<MembersRepository>()
        coEvery { repo.listMembers("fam1") } returns Result.failure(Exception("permission-denied"))
        coEvery { repo.listInvites("fam1") } returns Result.success(emptyList())
        composeRule.setContent {
            AuntieOSTheme {
                HouseholdMembersBody(
                    kinfolkName = "the Walls",
                    viewModel = HouseholdMembersViewModel(
                        kinfolkId = "fam1",
                        householdName = "the Walls",
                        repository = repo,
                    ),
                )
            }
        }
        composeRule.waitForIdle()

        assertEquals(1, composeRule.onAllNodesWithText("permission-denied", substring = true).fetchSemanticsNodes().size)
        composeRule.onNodeWithText("Secondary contacts unavailable", substring = true).assertIsDisplayed()
        assertEquals(0, composeRule.onAllNodesWithText("Nobody has claimed", substring = true).fetchSemanticsNodes().size)
        assertEquals(0, composeRule.onAllNodesWithText("No secondary contacts yet", substring = true).fetchSemanticsNodes().size)
        // The where line stays the id alone: an unread roster has no count.
        composeRule.onNodeWithText("familyId: fam1").assertIsDisplayed()
    }
}
