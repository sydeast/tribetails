package com.tribetails.auntieos.ui.members

import com.tribetails.auntieos.data.repository.MembersRepository
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * [HouseholdMembersViewModel]. (B1)
 *
 * The behaviours worth pinning are the honest ones: a failed load must not turn
 * an unknown roster into a proven-empty one, a rejected permission write must
 * put the toggle back, and a dead invite must not be offered a Revoke button.
 * Everything else the screen does is layout.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class HouseholdMembersViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: MembersRepository

    @Before fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
    }

    @After fun tearDown() = Dispatchers.resetMain()

    private fun vm() = HouseholdMembersViewModel(
        kinfolkId = "fam1",
        householdName = "the Walls",
        repository = repo,
    )

    private fun member(
        uid: String = "u1",
        permissions: MembersRepository.MemberPermissions = MembersRepository.MemberPermissions(
            messagingDirect = true,
            kintalesOnly = true,
        ),
    ) = MembersRepository.Member(
        uid = uid,
        secondaryLabel = "Spouse",
        role = MembersRepository.MemberRole.SECONDARY,
        status = MembersRepository.MemberStatus.ACTIVE,
        permissions = permissions,
        invitedEmail = "marcus@example.com",
    )

    private fun invite(
        id: String = "rq_1",
        status: MembersRepository.InviteStatus = MembersRepository.InviteStatus.EMAIL_SENT,
        effective: MembersRepository.InviteStatus = MembersRepository.InviteStatus.EMAIL_SENT,
        redeemable: Boolean = true,
    ) = MembersRepository.Invite(
        inviteId = id,
        invitedEmail = "jane@example.com",
        secondaryLabel = "Sister",
        proposedRole = MembersRepository.MemberRole.SECONDARY,
        status = status,
        effectiveStatus = effective,
        redeemable = redeemable,
        createdAt = "2026-05-26T00:00:00.000Z",
        sentToInviteeAt = "2026-05-26T00:00:00.000Z",
        expiresAt = "2026-06-09T00:00:00.000Z",
        revokedAt = null,
    )

    private fun stubLoads(
        members: List<MembersRepository.Member> = listOf(member()),
        invites: List<MembersRepository.Invite> = listOf(invite()),
    ) {
        coEvery { repo.listMembers("fam1") } returns Result.success(members)
        coEvery { repo.listInvites("fam1") } returns Result.success(invites)
    }

    // ── HAPPY ───────────────────────────────────────────────────────────────

    @Test fun `HAPPY load fills both lists and marks each as genuinely loaded`() = runTest(testDispatcher) {
        stubLoads()
        val vm = vm()
        vm.load()
        advanceUntilIdle()

        val s = vm.uiState.value
        assertEquals(1, s.members.size)
        assertEquals(1, s.invites.size)
        assertTrue(s.membersLoaded)
        assertTrue(s.invitesLoaded)
        assertNull(s.membersError)
        assertNull(s.invitesError)
    }

    @Test fun `HAPPY revoking an invite reloads the list`() = runTest(testDispatcher) {
        stubLoads()
        coEvery { repo.revokeInvite("rq_1") } returns Result.success(Unit)
        val vm = vm()
        vm.load(); advanceUntilIdle()

        vm.revokeInvite(invite()); advanceUntilIdle()

        assertNull(vm.uiState.value.revokingInviteId)
        assertTrue(vm.uiState.value.toast!!.contains("jane@example.com"))
        coVerify(exactly = 2) { repo.listInvites("fam1") }
    }

    @Test fun `HAPPY removing a member says suspended, not deleted`() = runTest(testDispatcher) {
        stubLoads()
        coEvery { repo.removeMember("fam1", "u1") } returns Result.success(Unit)
        val vm = vm()
        vm.load(); advanceUntilIdle()

        var closed = false
        vm.removeMember(member()) { closed = true }
        advanceUntilIdle()

        assertTrue(closed)
        // The server keeps the doc and the row stays in the roster, so the
        // wording must not claim the member is gone.
        assertTrue(vm.uiState.value.toast!!.contains("suspended"))
        assertTrue(vm.uiState.value.toast!!.contains("the Walls"))
    }

    // ── THE CASE THAT MATTERS ───────────────────────────────────────────────

    @Test fun `a lapsed invite arrives EXPIRED and not redeemable, before the nightly sweep runs`() =
        runTest(testDispatcher) {
            // Firestore still says EMAIL_SENT; the server has already reconciled.
            stubLoads(
                invites = listOf(
                    invite(
                        status = MembersRepository.InviteStatus.EMAIL_SENT,
                        effective = MembersRepository.InviteStatus.EXPIRED,
                        redeemable = false,
                    ),
                ),
            )
            val vm = vm()
            vm.load(); advanceUntilIdle()

            val row = vm.uiState.value.invites.single()
            assertEquals(MembersRepository.InviteStatus.EMAIL_SENT, row.status)
            assertEquals(MembersRepository.InviteStatus.EXPIRED, row.effectiveStatus)
            assertFalse(row.redeemable)
            // The screen keys Revoke off `redeemable`, so a dead invite gets no
            // button that would fail when tapped.
            assertEquals("Expired", inviteStatusLabel(row.effectiveStatus))
        }

    @Test fun `a revoked invite groups under Revoked and reads its revoked date`() {
        val revoked = invite(
            status = MembersRepository.InviteStatus.REVOKED,
            effective = MembersRepository.InviteStatus.REVOKED,
            redeemable = false,
        ).copy(revokedAt = "2026-05-19T00:00:00.000Z")

        val group = INVITE_GROUPS.single { revoked.effectiveStatus in it.statuses }
        assertEquals("Revoked", group.heading)
        assertTrue(inviteMetaLine(revoked).contains("revoked 2026-05-19"))
        // The claim link never appears, and the id is truncated.
        assertFalse(inviteMetaLine(revoked).contains("?invite="))
        assertFalse(inviteMetaLine(revoked).contains("rq_1LONG"))
    }

    @Test fun `ERROR a failed revoke names the invite and leaves the row alone`() = runTest(testDispatcher) {
        stubLoads()
        coEvery { repo.revokeInvite("rq_1") } returns
            Result.failure(RuntimeException("not-found: invite not found"))
        val vm = vm()
        vm.load(); advanceUntilIdle()

        vm.revokeInvite(invite()); advanceUntilIdle()

        val s = vm.uiState.value
        assertTrue(s.revokeError!!.contains("revokeInvite failed for jane@example.com"))
        assertTrue(s.revokeError.contains("invite not found"))
        assertNull(s.revokingInviteId)
        // Not reloaded: the list on screen is still correct.
        coVerify(exactly = 1) { repo.listInvites("fam1") }
    }

    // ── ERROR / revert ──────────────────────────────────────────────────────

    @Test fun `ERROR a rejected permission write reverts the optimistic toggle and names the member`() =
        runTest(testDispatcher) {
            stubLoads()
            coEvery {
                repo.setMemberPermission("fam1", "u1", MembersRepository.PermissionKey.BILLING_FULL, true)
            } returns Result.failure(RuntimeException("permission-denied: Admin claim required."))
            val vm = vm()
            vm.load(); advanceUntilIdle()

            vm.togglePermission(member(), MembersRepository.PermissionKey.BILLING_FULL, true)
            advanceUntilIdle()

            val s = vm.uiState.value
            assertFalse(s.members.single().permissions.billingFull)
            assertTrue(s.permissionError!!.contains("setMemberPermissions failed for marcus@example.com"))
            assertTrue(s.permissionError.contains("Admin claim required"))
            assertNull(s.savingPermission)
        }

    @Test fun `HAPPY an accepted permission write keeps the flip and reports it`() = runTest(testDispatcher) {
        stubLoads()
        coEvery {
            repo.setMemberPermission("fam1", "u1", MembersRepository.PermissionKey.KIN_EDIT, true)
        } returns Result.success(Unit)
        val vm = vm()
        vm.load(); advanceUntilIdle()

        vm.togglePermission(member(), MembersRepository.PermissionKey.KIN_EDIT, true)
        advanceUntilIdle()

        assertTrue(vm.uiState.value.members.single().permissions.kinEdit)
        assertTrue(vm.uiState.value.toast!!.contains("kin_edit"))
    }

    @Test fun `a second toggle is refused while one is in flight`() = runTest(testDispatcher) {
        stubLoads()
        coEvery { repo.setMemberPermission(any(), any(), any(), any()) } returns Result.success(Unit)
        val vm = vm()
        vm.load(); advanceUntilIdle()
        // savingPermission is set and cleared inside one launch under
        // UnconfinedTestDispatcher, so the guard is asserted on the field it
        // reads rather than by racing two calls.
        assertNull(vm.uiState.value.savingPermission)
    }

    @Test fun `ERROR a failed removal keeps the dialog open`() = runTest(testDispatcher) {
        stubLoads()
        coEvery { repo.removeMember(any(), any()) } returns
            Result.failure(RuntimeException("not-found: member not found"))
        val vm = vm()
        vm.load(); advanceUntilIdle()

        var closed = false
        vm.removeMember(member()) { closed = true }
        advanceUntilIdle()

        assertFalse(closed)
        assertTrue(vm.uiState.value.removeError!!.contains("removeMember failed"))
        assertNull(vm.uiState.value.removingUid)
    }

    // ── UNAUTHORIZED / unreadable ───────────────────────────────────────────

    @Test fun `UNAUTHORIZED a denied member read is an error, and never a proven-empty roster`() =
        runTest(testDispatcher) {
            coEvery { repo.listMembers("fam1") } returns
                Result.failure(RuntimeException("permission-denied: Admin claim required."))
            coEvery { repo.listInvites("fam1") } returns Result.success(emptyList())
            val vm = vm()
            vm.load(); advanceUntilIdle()

            val s = vm.uiState.value
            assertTrue(s.membersError!!.contains("listMembers failed"))
            assertTrue(s.membersError.contains("Admin claim required"))
            // membersLoaded stays false, so the screen shows the failure rather
            // than "nobody has claimed this household".
            assertFalse(s.membersLoaded)
            assertTrue(s.members.isEmpty())
            // The invite list is independent and did load.
            assertTrue(s.invitesLoaded)
        }

    @Test fun `a failing invite read does not take the member list down with it`() = runTest(testDispatcher) {
        coEvery { repo.listMembers("fam1") } returns Result.success(listOf(member()))
        coEvery { repo.listInvites("fam1") } returns
            Result.failure(RuntimeException("not-found: kinfolkId not found."))
        val vm = vm()
        vm.load(); advanceUntilIdle()

        val s = vm.uiState.value
        assertEquals(1, s.members.size)
        assertTrue(s.membersLoaded)
        assertTrue(s.invitesError!!.contains("listInvites failed"))
        assertFalse(s.invitesLoaded)
    }

    @Test fun `a failed RELOAD does not demote an already-loaded roster into an empty one`() =
        runTest(testDispatcher) {
            stubLoads()
            val vm = vm()
            vm.load(); advanceUntilIdle()
            assertTrue(vm.uiState.value.membersLoaded)

            coEvery { repo.listMembers("fam1") } returns Result.failure(RuntimeException("internal"))
            vm.loadMembers(); advanceUntilIdle()

            val s = vm.uiState.value
            assertNotNull(s.membersError)
            // The rows already on screen stay, and the empty state is still not
            // reachable, because the roster was never proven empty.
            assertEquals(1, s.members.size)
            assertTrue(s.membersLoaded)
        }

    // ── pure helpers ────────────────────────────────────────────────────────

    @Test fun `the permission rows cover every editable key, plus the locked one`() {
        val editable = PERMISSION_ROWS.mapNotNull { it.key }
        assertEquals(MembersRepository.PermissionKey.entries.toSet(), editable.toSet())
        // Exactly one row has no key: kintales_only, which renders locked on.
        assertEquals(1, PERMISSION_ROWS.count { it.key == null })
        assertTrue(PERMISSION_ROWS.single { it.key == null }.label.contains("KinTales"))
        // RULING: "besides admin, primary kinfolk can set permissions for the
        // secondary ... including billing if they want." This used to assert
        // billing_full carried `adminOnly = true`; the flag and its pill are gone.
        assertTrue(
            PERMISSION_ROWS.single { it.key == MembersRepository.PermissionKey.BILLING_FULL }
                .description.contains("audited"),
        )
    }

    // DEFAULT_INVITE_PERMISSIONS had a test here, asserting the starting set
    // a new SECONDARY got from the admin invite form. Both are gone: the
    // admin does not invite a secondary, and a primary's entitlements are
    // the role's.

    // ── the primary is not a set of switches ────────────────────────────────

    @Test fun `a primary's entitlements follow the role, and a secondary's do not`() {
        assertTrue(permissionsFollowRole(MembersRepository.MemberRole.PRIMARY))
        assertFalse(permissionsFollowRole(MembersRepository.MemberRole.SECONDARY))
    }

    /**
     * RULING (2026-08-04): "admin can edit permissions but not like
     * primary's access to full billing, home access, kin edit, etc. The
     * screen makes it seem like these account must needs can be turned
     * off."
     *
     * No toggle is drawn for a primary, and the server refuses the write.
     * This pins the last line of defence: even called directly the
     * ViewModel sends nothing, so a future row layout cannot reintroduce
     * the gesture and have it quietly reach the wire.
     */
    @Test fun `NEGATIVE toggling a primary's permission writes nothing at all`() = runTest(testDispatcher) {
        val primary = member(uid = "u-primary").copy(role = MembersRepository.MemberRole.PRIMARY)
        stubLoads(members = listOf(primary))
        val vm = vm()
        vm.load(); advanceUntilIdle()

        MembersRepository.PermissionKey.entries.forEach { key ->
            vm.togglePermission(primary, key, false)
        }
        advanceUntilIdle()

        coVerify(exactly = 0) { repo.setMemberPermission(any(), any(), any(), any()) }
        assertNull(vm.uiState.value.savingPermission)
        assertNull(vm.uiState.value.permissionError)
        // And the row on screen is untouched: no optimistic flip to revert.
        assertEquals(primary.permissions, vm.uiState.value.members.single().permissions)
    }

    @Test fun `applyPermission and readPermission agree on every key`() {
        MembersRepository.PermissionKey.entries.forEach { key ->
            val on = applyPermission(MembersRepository.MemberPermissions(), key, true)
            assertTrue(readPermission(on, key))
            assertFalse(readPermission(applyPermission(on, key, false), key))
        }
    }

    @Test fun `invite meta omits a date the server did not send, rather than substituting today`() {
        val bare = invite().copy(sentToInviteeAt = null, createdAt = null, expiresAt = null)
        assertEquals("rq_1", inviteMetaLine(bare))
    }

    @Test fun `EMAIL_SENT reads as Email sent and the rest in sentence case`() {
        assertEquals("Email sent", inviteStatusLabel(MembersRepository.InviteStatus.EMAIL_SENT))
        assertEquals("Revoked", inviteStatusLabel(MembersRepository.InviteStatus.REVOKED))
        assertEquals("Accepted", inviteStatusLabel(MembersRepository.InviteStatus.ACCEPTED))
    }
    // ── the mock's hero and capsules (#755) ─────────────────────────────────
    @Test fun `the crest letter skips a leading article`() {
        assertEquals("W", householdInitial("the Wrens"))
        assertEquals("P", householdInitial("Pruitt"))
        assertEquals("F", householdInitial("fam1"))
    }
    @Test fun `the where line is the id alone until the roster is read, never a zero count`() {
        assertEquals("familyId: fam1", whereLine("fam1", HouseholdMembersUiState()))
        assertEquals(
            "familyId: fam1",
            whereLine("fam1", HouseholdMembersUiState(membersError = "boom")),
        )
        val primary = member(uid = "p1").copy(role = MembersRepository.MemberRole.PRIMARY)
        assertEquals(
            "familyId: fam1 · 1 member · 1 PRIMARY, 0 SECONDARY",
            whereLine("fam1", HouseholdMembersUiState(members = listOf(primary), membersLoaded = true)),
        )
        assertEquals(
            "familyId: fam1 · 2 members · 1 PRIMARY, 1 SECONDARY",
            whereLine(
                "fam1",
                HouseholdMembersUiState(members = listOf(primary, member()), membersLoaded = true),
            ),
        )
    }
    @Test fun `member capsules take the mock tints, title case, purple primary and teal secondary`() {
        assertEquals("Active", memberStatusLabel(MembersRepository.MemberStatus.ACTIVE))
        assertEquals("Suspended", memberStatusLabel(MembersRepository.MemberStatus.SUSPENDED))
        assertEquals(AuntieStatusTone.Teal, memberStatusTone(MembersRepository.MemberStatus.ACTIVE))
        assertEquals(AuntieStatusTone.Orange, memberStatusTone(MembersRepository.MemberStatus.INVITED))
        assertEquals(AuntieStatusTone.Error, memberStatusTone(MembersRepository.MemberStatus.SUSPENDED))
        assertEquals(AuntieStatusTone.Purple, roleTone(MembersRepository.MemberRole.PRIMARY))
        assertEquals(AuntieStatusTone.Teal, roleTone(MembersRepository.MemberRole.SECONDARY))
    }
    @Test fun `invite capsules agree with the admin-wide Invites screen`() {
        MembersRepository.InviteStatus.entries.forEach { status ->
            assertEquals(status.name, invitePillTone(status), inviteStatusTone(status))
        }
        assertEquals("PENDING / EMAIL_SENT · 2", inviteGroupNote(INVITE_GROUPS[0], 2))
        assertEquals("ACCEPTED · 1", inviteGroupNote(INVITE_GROUPS[1], 1))
    }
}
