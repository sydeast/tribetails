package com.tribetails.auntieos.ui.members

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
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
 * contact and Secondary kinfolk (Q4, 2026-09-27) with the mock's notes, a primary carries the
 * "granted by role" capsule and no switch, a secondary carries the permission
 * list with the Locked on chip. And the rulings that have been rebuilt wrong
 * before: no switch on a primary, no admin-minted secondary invite, and (since
 * the 2026-09-27 ruling on #829, "there is no true 'Contact List'") no contacts
 * list: no "Add secondary contact", no "No portal account" rows, and "Invite to
 * portal" alone in the hero.
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

    private fun setContent(
        members: List<MembersRepository.Member>,
        people: List<MembersRepository.SecondaryPerson> = emptyList(),
    ) {
        val repo = mockk<MembersRepository>()
        coEvery { repo.listMembers("fam1") } returns Result.success(members)
        coEvery { repo.listInvites("fam1") } returns Result.success(emptyList())
        coEvery { repo.listSecondaryKinfolk("fam1") } returns Result.success(people)
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
        composeRule.onNodeWithText("Secondary kinfolk").assertIsDisplayed()
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

        // The two PRIMARY-only callables, the typed-address primary invite, and
        // (ruling 2026-09-27, #829) the contacts list's add button.
        for (label in listOf("Save label", "Swap contact info", "Invite a primary", "Add secondary contact")) {
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
        coEvery { repo.listSecondaryKinfolk("fam1") } returns Result.success(emptyList())
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
        composeRule.onNodeWithText("Secondary kinfolk unavailable", substring = true).assertIsDisplayed()
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
     * RULING (2026-09-27, #829): "there is no true 'Contact List'." The hero
     * carries the invite alone, the Secondary kinfolk panel holds members
     * only, and nothing reads the contacts. `mockk` is strict here, so a call
     * to `listHouseholdContacts` would fail the test on its own.
     */
    @Test
    fun `there is no contacts list, and the invite is the hero's one action`() {
        setContent(listOf(member("u1", MembersRepository.MemberRole.SECONDARY, "marcus@example.com")))

        composeRule.onNodeWithText("Invite to portal").assertIsDisplayed()
        for (text in listOf("Add secondary contact", "No portal account", "No contact has been recorded")) {
            assertEquals(
                "HouseholdMembersScreen must not show \"$text\"",
                0,
                composeRule.onAllNodesWithText(text, substring = true, ignoreCase = true).fetchSemanticsNodes().size,
            )
        }
        composeRule.onNodeWithText("marcus@example.com").assertIsDisplayed()
    }

    /**
     * Operator rulings 2026-09-27. Q4: the panel is "Secondary kinfolk". Q3:
     * the admin adds a secondary kinfolk with no invite and no portal access,
     * and never invites one.
     */
    @Test
    fun `Q3 Q4 the panel is Secondary kinfolk, offers Add, and lists people with their access state and no invite control`() {
        setContent(
            members = listOf(member("u1", MembersRepository.MemberRole.SECONDARY, "marcus@example.com")),
            people = listOf(
                MembersRepository.SecondaryPerson("p1", "Sam Lee", "+18055550177", null, MembersRepository.PersonAccess.NONE, null),
                MembersRepository.SecondaryPerson("p2", "Jo Park", null, "jo@example.com", MembersRepository.PersonAccess.INVITED, null),
                MembersRepository.SecondaryPerson("p3", "Ann Doe", null, null, MembersRepository.PersonAccess.ACTIVE, "u9"),
            ),
        )
        composeRule.onNodeWithText("Secondary kinfolk").assertIsDisplayed()
        assertEquals(0, composeRule.onAllNodesWithText("Secondary contacts", substring = true).fetchSemanticsNodes().size)
        composeRule.onNode(hasText("Add secondary kinfolk") and hasClickAction()).assertIsDisplayed()
        composeRule.onNodeWithText("Sam Lee").assertIsDisplayed()
        composeRule.onNodeWithText("No portal access").assertIsDisplayed()
        composeRule.onNodeWithText("Jo Park").assertIsDisplayed()
        assertEquals(true, composeRule.onAllNodesWithText("Invited").fetchSemanticsNodes().isNotEmpty())
        // ACTIVE is already a member row; the person record is not repeated.
        assertEquals(0, composeRule.onAllNodesWithText("Ann Doe").fetchSemanticsNodes().size)
        // The admin cannot invite a secondary kinfolk: no invite control on any row.
        for (text in listOf("Give portal access", "Invite to MyTribe", "Send invite")) {
            assertEquals(0, composeRule.onAllNodesWithText(text, substring = true, ignoreCase = true).fetchSemanticsNodes().size)
        }
    }
    @Test
    fun `Q3 Add opens the dialog with Name, Phone (optional) and Email (optional)`() {
        setContent(members = emptyList())
        composeRule.onNode(hasText("Add secondary kinfolk") and hasClickAction()).performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("No invite is sent. Only their primary can give them portal access.").assertIsDisplayed()
        composeRule.onNodeWithText("PHONE (OPTIONAL)").assertExists()
        composeRule.onNodeWithText("EMAIL (OPTIONAL)").assertExists()
        // AuntieField draws its label uppercased.
    }
}
