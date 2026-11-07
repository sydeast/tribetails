package com.tribetails.auntieos.ui.members

import com.tribetails.auntieos.data.repository.MembersRepository
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * #1602: the Members hero's Invite to portal looked usable when it could not
 * succeed, then said the household already had an account. It is now off,
 * with the reason, when there is no email on file or a primary is ACTIVE.
 */
class PortalInviteBlockerTest {

    private fun primary(status: MembersRepository.MemberStatus) = MembersRepository.Member(
        uid = "u1",
        secondaryLabel = null,
        role = MembersRepository.MemberRole.PRIMARY,
        status = status,
        permissions = MembersRepository.MemberPermissions(),
        invitedEmail = null,
    )

    @Test
    fun anActivePrimaryTurnsItOff() {
        val state = HouseholdMembersUiState(
            membersLoaded = true,
            members = listOf(primary(MembersRepository.MemberStatus.ACTIVE)),
            householdEmailLoaded = true,
            householdEmail = "catch@hanasamku.com",
        )
        assertEquals("Already on the portal.", portalInviteBlockerFor(state))
    }

    @Test
    fun noEmailOnFileTurnsItOff() {
        val state = HouseholdMembersUiState(membersLoaded = true, householdEmailLoaded = true, householdEmail = "")
        assertEquals("No email on file, so there is nobody to invite.", portalInviteBlockerFor(state))
    }

    @Test
    fun anUnreadEmailOrRosterNeverTurnsItOff() {
        assertNull(portalInviteBlockerFor(HouseholdMembersUiState()))
        val suspended = HouseholdMembersUiState(
            membersLoaded = true,
            members = listOf(primary(MembersRepository.MemberStatus.SUSPENDED)),
            householdEmailLoaded = true,
            householdEmail = "catch@hanasamku.com",
        )
        assertNull(portalInviteBlockerFor(suspended))
    }
}
