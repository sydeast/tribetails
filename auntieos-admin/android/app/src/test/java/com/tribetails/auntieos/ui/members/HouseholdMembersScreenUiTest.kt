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
 * before: no switch on a primary, no admin-minted secondary invite, and (since
 * 2026-09-12) the two gestures the hero keeps apart, "Add secondary contact"
 * (a person with no portal account) and "Invite to portal" (the claim link).
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

    private fun contact(
        contactId: String = "c1",
        name: String = "Ada Rivera",
        label: String = "Sister",
        phone: String? = "805 555 0143",
        email: String? = null,
    ) = MembersRepository.Contact(
        contactId = contactId,
        name = name,
        label = label,
        phone = phone,
        email = email,
        createdAt = null,
        updatedAt = null,
    )

    private fun setContent(
        members: List<MembersRepository.Member>,
        contacts: List<MembersRepository.Contact> = emptyList(),
    ) {
        val repo = mockk<MembersRepository>()
        coEvery { repo.listMembers("fam1") } returns Result.success(members)
        coEvery { repo.listInvites("fam1") } returns Result.success(emptyList())
        coEvery { repo.listHouseholdContacts("fam1") } returns Result.success(contacts)
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
        composeRule.onNodeWithText("1 of role: SECONDARY · 0 contacts, no portal account")
            .assertIsDisplayed()
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

        // "Add secondary contact" is NOT on this list any more: the 2026-09-12
        // ruling restores it, and it mints no invite. What stays forbidden is
        // the two PRIMARY-only callables and the typed-address primary invite.
        for (label in listOf("Save label", "Swap contact info", "Invite a primary")) {
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
        coEvery { repo.listHouseholdContacts("fam1") } returns Result.success(emptyList())
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
        assertEquals(
            0,
            composeRule.onAllNodesWithText("has been invited to the portal as a secondary", substring = true)
                .fetchSemanticsNodes().size,
        )
        // The where line stays the id alone: an unread roster has no count.
        composeRule.onNodeWithText("familyId: fam1").assertIsDisplayed()
    }

    /**
     * RULING (2026-09-12): "a secondary contact does not have to be a portal
     * user. primary kinfolk user will invite a second kinfolk to the household
     * to manage and receive notifications." Two actions, and the #755 sweep
     * shipped one of them wearing the other's label.
     */
    @Test
    fun `the hero carries both gestures, and the mock's primary slot is the contact`() {
        setContent(listOf(member("u1", MembersRepository.MemberRole.SECONDARY, "marcus@example.com")))

        composeRule.onNodeWithText("Invite to portal").assertIsDisplayed()
        // Twice: the hero action and the mock's dashed row under the list.
        assertEquals(
            2,
            composeRule.onAllNodesWithText("Add secondary contact").fetchSemanticsNodes().size,
        )
    }

    @Test
    fun `a contact draws with no portal account, no uid and no permission list`() {
        setContent(
            listOf(member("u1", MembersRepository.MemberRole.SECONDARY, "marcus@example.com")),
            contacts = listOf(contact()),
        )

        composeRule.onNodeWithText("Ada Rivera").assertIsDisplayed()
        composeRule.onNodeWithText("NO PORTAL ACCOUNT").assertIsDisplayed()
        composeRule.onNodeWithText("Sister · 805 555 0143").assertIsDisplayed()
        composeRule.onNodeWithText("1 contact").assertIsDisplayed()
        // The panel note counts both kinds.
        composeRule.onNodeWithText("1 of role: SECONDARY · 1 contact, no portal account")
            .assertIsDisplayed()
        // One permission list on the page, and it belongs to the MEMBER.
        assertEquals(1, composeRule.onAllNodesWithText("PERMISSIONS").fetchSemanticsNodes().size)
    }

    /** A contact list that failed must never read as a household with nobody. */
    @Test
    fun `an unreadable contact list is named and no empty state is drawn`() {
        val repo = mockk<MembersRepository>()
        coEvery { repo.listMembers("fam1") } returns Result.success(
            listOf(member("u1", MembersRepository.MemberRole.SECONDARY, "marcus@example.com")),
        )
        coEvery { repo.listInvites("fam1") } returns Result.success(emptyList())
        coEvery { repo.listHouseholdContacts("fam1") } returns Result.failure(Exception("backend down"))
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

        composeRule.onNodeWithText("backend down", substring = true).assertIsDisplayed()
        assertEquals(
            0,
            composeRule.onAllNodesWithText("No contact has been recorded", substring = true)
                .fetchSemanticsNodes().size,
        )
        // The roster read is separate and still landed.
        composeRule.onNodeWithText("marcus@example.com").assertIsDisplayed()
    }
}
