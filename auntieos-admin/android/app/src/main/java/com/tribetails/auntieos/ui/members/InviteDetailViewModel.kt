package com.tribetails.auntieos.ui.members

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.data.repository.MembersRepository
import com.tribetails.auntieos.data.repository.inviteDate
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * ONE invite (#1339). The Android mirror of
 * `auntieos-admin/src/screens/InviteDetail.tsx`; the two move together.
 *
 * Reached by tapping a row on [InvitesScreen]. The app registers no https
 * deep link for the admin domain (only `auntieos://calls`, behind a signature
 * permission), so the `invite.auntie-notify` email link opens admin web, and
 * this is the same screen reached from the list.
 *
 * FAIL LOUD, AND DO NOT DEMOTE WHAT WAS READ. A failed reload keeps the invite
 * already on screen and sets [InviteDetailUiState.error] beside it.
 */
data class InviteDetailUiState(
    val invite: MembersRepository.InviteDetail? = null,
    val loading: Boolean = false,
    val error: String? = null,
)

class InviteDetailViewModel(
    private val inviteId: String,
    private val repository: MembersRepository = MembersRepository(),
) : ViewModel() {

    private val _uiState = MutableStateFlow(InviteDetailUiState())
    val uiState: StateFlow<InviteDetailUiState> = _uiState.asStateFlow()

    fun load() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(loading = true, error = null)
            repository.getInvite(inviteId).fold(
                onSuccess = { detail ->
                    _uiState.value = _uiState.value.copy(invite = detail, loading = false)
                },
                onFailure = { err ->
                    _uiState.value = _uiState.value.copy(
                        loading = false,
                        error = "getInvite failed: ${err.message ?: "Load failed"}",
                    )
                },
            )
        }
    }
}

private fun partyLabel(party: MembersRepository.InviteParty): String = when {
    party.displayName != null && party.email != null -> "${party.displayName} (${party.email})"
    else -> party.displayName ?: party.email ?: "Account not found"
}

/** Who sent it, in words. Mirrors `invitedByLabel` on web. */
internal fun invitedByLabel(detail: MembersRepository.InviteDetail): String = when {
    detail.invitedByAuntie -> "TribeTails (admin invite)"
    detail.invitedBy == null -> "Household primary (account not recorded)"
    else -> "${partyLabel(detail.invitedBy)}, household primary"
}

/** When and by whom it was claimed. Mirrors `claimedLabel` on web. */
internal fun claimedLabel(detail: MembersRepository.InviteDetail): String {
    if (detail.admin.invite.effectiveStatus != MembersRepository.InviteStatus.ACCEPTED) return "Not claimed"
    val whenText = inviteDate(detail.acceptedAt) ?: "date not recorded"
    val by = detail.acceptedBy ?: return "Claimed, $whenText"
    return "$whenText, by ${partyLabel(by)}"
}

/** The permission labels this invite grants, in [PERMISSION_ROWS] order. */
internal fun grantedPermissionLabels(p: MembersRepository.MemberPermissions): List<String> =
    PERMISSION_ROWS.filter { row ->
        when (row.key) {
            MembersRepository.PermissionKey.BILLING_FULL -> p.billingFull
            MembersRepository.PermissionKey.MESSAGING_DIRECT -> p.messagingDirect
            MembersRepository.PermissionKey.MESSAGING_GROUP -> p.messagingGroup
            MembersRepository.PermissionKey.KIN_EDIT -> p.kinEdit
            MembersRepository.PermissionKey.HOME_ACCESS -> p.homeAccess
            null -> p.kintalesOnly
        }
    }.map { it.label }

/**
 * The fact rows, label to value, in the order drawn. Pure so the order and the
 * words are tested without a Compose host.
 */
internal fun inviteDetailFacts(detail: MembersRepository.InviteDetail): List<Pair<String, String>> {
    val invite = detail.admin.invite
    val rows = mutableListOf(
        "Household" to detail.admin.householdName,
        "Invited by" to invitedByLabel(detail),
        "Invited" to invite.invitedEmail,
        "Role" to roleLabel(invite.proposedRole),
        "Status" to inviteStatusLabel(invite.effectiveStatus),
        "Created" to (inviteDate(invite.createdAt) ?: "unknown"),
        "Sent" to (inviteDate(invite.sentToInviteeAt) ?: "not sent"),
    )
    when (invite.effectiveStatus) {
        MembersRepository.InviteStatus.PENDING,
        MembersRepository.InviteStatus.EMAIL_SENT -> rows += "Expires" to (inviteDate(invite.expiresAt) ?: "unknown")
        MembersRepository.InviteStatus.EXPIRED -> rows += "Expired" to (inviteDate(invite.expiresAt) ?: "unknown")
        MembersRepository.InviteStatus.REVOKED -> rows += "Revoked" to (inviteDate(invite.revokedAt) ?: "unknown")
        MembersRepository.InviteStatus.ACCEPTED -> Unit
    }
    rows += "Claimed" to claimedLabel(detail)
    val perms = grantedPermissionLabels(detail.permissions)
    rows += "Permissions" to (if (perms.isEmpty()) "None" else perms.joinToString(", "))
    detail.source?.let { rows += "Source" to it }
    return rows
}
