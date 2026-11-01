package com.tribetails.auntieos.ui.members

import com.tribetails.auntieos.data.repository.MembersRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * [InviteDetailViewModel] and its pure labels (#1339), the Android mirror of
 * `auntieos-admin/src/screens/InviteDetail.tsx`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class InviteDetailViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: MembersRepository

    @Before fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
    }

    @After fun tearDown() = Dispatchers.resetMain()

    @Test
    fun `load reads the invite by its id and holds it`() {
        coEvery { repo.getInvite("rq_1") } returns Result.success(inviteDetail())
        val vm = InviteDetailViewModel("rq_1", repo)

        vm.load()

        val state = vm.uiState.value
        assertEquals("jane@example.com", state.invite?.admin?.invite?.invitedEmail)
        assertFalse(state.loading)
        assertNull(state.error)
        coVerify(exactly = 1) { repo.getInvite("rq_1") }
    }

    @Test
    fun `a failed read says so, and a failed reload keeps the invite already read`() {
        coEvery { repo.getInvite("rq_1") } returnsMany listOf(
            Result.failure(IllegalStateException("No invite with that id.")),
            Result.success(inviteDetail()),
            Result.failure(IllegalStateException("offline")),
        )
        val vm = InviteDetailViewModel("rq_1", repo)

        vm.load()
        assertEquals("getInvite failed: No invite with that id.", vm.uiState.value.error)
        assertNull(vm.uiState.value.invite)

        vm.load()
        assertNotNull(vm.uiState.value.invite)

        vm.load()
        assertEquals("getInvite failed: offline", vm.uiState.value.error)
        assertNotNull(vm.uiState.value.invite)
    }

    @Test
    fun `facts say who invited whom, the household, role, status and dates, in order`() {
        val facts = inviteDetailFacts(inviteDetail())
        assertEquals(
            listOf(
                "Household" to "the Demos",
                "Invited by" to "Dora Demo (dora@example.com), household primary",
                "Invited" to "jane@example.com",
                "Role" to "Secondary",
                "Status" to "Email sent",
                "Created" to "2026-10-01",
                "Sent" to "2026-10-01",
                "Expires" to "2026-10-08",
                "Claimed" to "Not claimed",
                "Permissions" to "Direct messaging",
                "Source" to "mytribe-portal",
            ),
            facts,
        )
    }

    @Test
    fun `labels name a business invite, an unreadable inviter, and a claim with or without its date`() {
        assertEquals("TribeTails (admin invite)", invitedByLabel(inviteDetail(invitedByAuntie = true, invitedBy = null)))
        assertEquals(
            "Account not found, household primary",
            invitedByLabel(inviteDetail(invitedBy = MembersRepository.InviteParty("p1", null, null))),
        )
        val accepted = MembersRepository.InviteStatus.ACCEPTED
        assertEquals(
            "2026-10-03, by jane@example.com",
            claimedLabel(
                inviteDetail(
                    status = accepted,
                    acceptedAt = "2026-10-03T08:30:00.000Z",
                    acceptedBy = MembersRepository.InviteParty("u7", null, "jane@example.com"),
                ),
            ),
        )
        assertEquals("Claimed, date not recorded", claimedLabel(inviteDetail(status = accepted)))
    }
}

internal fun inviteDetail(
    status: MembersRepository.InviteStatus = MembersRepository.InviteStatus.EMAIL_SENT,
    invitedByAuntie: Boolean = false,
    invitedBy: MembersRepository.InviteParty? = MembersRepository.InviteParty("p1", "Dora Demo", "dora@example.com"),
    acceptedBy: MembersRepository.InviteParty? = null,
    acceptedAt: String? = null,
    tribeId: String = "fam_77",
) = MembersRepository.InviteDetail(
    admin = MembersRepository.AdminInvite(
        invite = MembersRepository.Invite(
            inviteId = "rq_8fk29aLONGTAIL",
            invitedEmail = "jane@example.com",
            secondaryLabel = "Sister",
            proposedRole = MembersRepository.MemberRole.SECONDARY,
            status = status,
            effectiveStatus = status,
            redeemable = status == MembersRepository.InviteStatus.EMAIL_SENT,
            createdAt = "2026-10-01T10:00:00.000Z",
            sentToInviteeAt = "2026-10-01T10:00:05.000Z",
            expiresAt = "2026-10-08T10:00:00.000Z",
            revokedAt = null,
        ),
        tribeId = tribeId,
        householdName = "the Demos",
    ),
    permissions = MembersRepository.MemberPermissions(messagingDirect = true),
    invitedByAuntie = invitedByAuntie,
    invitedBy = invitedBy,
    acceptedBy = acceptedBy,
    acceptedAt = acceptedAt,
    source = "mytribe-portal",
)
