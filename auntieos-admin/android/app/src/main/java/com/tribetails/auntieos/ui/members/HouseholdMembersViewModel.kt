package com.tribetails.auntieos.ui.members

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.data.repository.MembersRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Household members and invites. (B1)
 *
 * The flat data-class UiState + Kotlin `Result` idiom used by
 * `CoveragePackageViewModel` and `AdminSettingsViewModel`. The React mirror is
 * `auntieos-admin/src/screens/HouseholdMembers.tsx`; the two screens call the
 * same callables and have to move together. `mintInvite` is no longer one of
 * them: the typed-address "Invite a primary by email" dialog is gone (issue
 * #684), so this ViewModel has no mint state and no mint handler any more.
 *
 * FAIL LOUD, AND SEPARATELY. Each write carries its own error field and its
 * own in-flight marker rather than sharing one `error: String?`. A failed
 * revoke and a failed permission save are different things to fix, and a
 * screen that reports "Save failed" for either tells the operator nothing. A
 * permission toggle is optimistic and REVERTS on failure.
 *
 * `loadError` is deliberately per-list too. The member roster failing must not
 * blank the invite list, and an unreadable list must never render as an empty
 * one: `membersLoaded` / `invitesLoaded` say whether the empty state has been
 * earned.
 */
data class HouseholdMembersUiState(
    val members: List<MembersRepository.Member> = emptyList(),
    val invites: List<MembersRepository.Invite> = emptyList(),
    val membersLoading: Boolean = false,
    val invitesLoading: Boolean = false,
    /** True only after a load that actually succeeded. Gates the empty state. */
    val membersLoaded: Boolean = false,
    val invitesLoaded: Boolean = false,
    val membersError: String? = null,
    val invitesError: String? = null,
    /** "<uid>:<PermissionKey>" while that one toggle is in flight. */
    val savingPermission: String? = null,
    val permissionError: String? = null,
    val revokingInviteId: String? = null,
    val revokeError: String? = null,
    val removingUid: String? = null,
    val removeError: String? = null,
    /** One-shot confirmation text for a write that landed. */
    val toast: String? = null,
)

class HouseholdMembersViewModel(
    val kinfolkId: String,
    private val householdName: String,
    private val repository: MembersRepository = MembersRepository(),
) : ViewModel() {

    private val _uiState = MutableStateFlow(HouseholdMembersUiState())
    val uiState: StateFlow<HouseholdMembersUiState> = _uiState.asStateFlow()

    fun load() {
        loadMembers()
        loadInvites()
    }

    fun loadMembers() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(membersLoading = true, membersError = null)
            repository.listMembers(kinfolkId).fold(
                onSuccess = { rows ->
                    _uiState.value = _uiState.value.copy(
                        members = rows,
                        membersLoading = false,
                        membersLoaded = true,
                    )
                },
                onFailure = { err ->
                    // membersLoaded stays as it was: a failed reload must not
                    // promote an unknown roster into a proven-empty one.
                    _uiState.value = _uiState.value.copy(
                        membersLoading = false,
                        membersError = "listMembers failed: ${err.message ?: "Load failed"}",
                    )
                },
            )
        }
    }

    fun loadInvites() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(invitesLoading = true, invitesError = null)
            repository.listInvites(kinfolkId).fold(
                onSuccess = { rows ->
                    _uiState.value = _uiState.value.copy(
                        invites = rows,
                        invitesLoading = false,
                        invitesLoaded = true,
                    )
                },
                onFailure = { err ->
                    _uiState.value = _uiState.value.copy(
                        invitesLoading = false,
                        invitesError = "listInvites failed: ${err.message ?: "Load failed"}",
                    )
                },
            )
        }
    }

    /**
     * Flip one permission flag, optimistically, and put it back if the server
     * refuses. A toggle that stays flipped after a rejected write is a lie about
     * what the household member can do.
     */
    fun togglePermission(
        member: MembersRepository.Member,
        key: MembersRepository.PermissionKey,
        next: Boolean,
    ) {
        if (_uiState.value.savingPermission != null) return
        // A primary holds every entitlement by role, no toggle is drawn for one,
        // and the server refuses the write. Belt and braces, so a future row
        // layout cannot reintroduce the gesture quietly.
        if (permissionsFollowRole(member.role)) return
        val before = _uiState.value.members
        _uiState.value = _uiState.value.copy(
            members = before.map { m ->
                if (m.uid == member.uid) m.copy(permissions = applyPermission(m.permissions, key, next)) else m
            },
            savingPermission = "${member.uid}:${key.name}",
            permissionError = null,
        )
        viewModelScope.launch {
            repository.setMemberPermission(kinfolkId, member.uid, key, next).fold(
                onSuccess = {
                    _uiState.value = _uiState.value.copy(
                        savingPermission = null,
                        toast = "${if (next) "Granted" else "Revoked"} ${key.wireName} for ${member.label}.",
                    )
                },
                onFailure = { err ->
                    _uiState.value = _uiState.value.copy(
                        members = before,
                        savingPermission = null,
                        permissionError =
                            "setMemberPermissions failed for ${member.label}: ${err.message ?: "Save failed"}",
                    )
                },
            )
        }
    }

    fun revokeInvite(invite: MembersRepository.Invite) {
        if (_uiState.value.revokingInviteId != null) return
        _uiState.value = _uiState.value.copy(revokingInviteId = invite.inviteId, revokeError = null)
        viewModelScope.launch {
            repository.revokeInvite(invite.inviteId).fold(
                onSuccess = {
                    _uiState.value = _uiState.value.copy(
                        revokingInviteId = null,
                        toast = "Revoked the invite to ${invite.invitedEmail}.",
                    )
                    loadInvites()
                },
                onFailure = { err ->
                    _uiState.value = _uiState.value.copy(
                        revokingInviteId = null,
                        revokeError = "revokeInvite failed for ${invite.invitedEmail}: " +
                            (err.message ?: "The invite is still live."),
                    )
                },
            )
        }
    }

    fun removeMember(member: MembersRepository.Member, onRemoved: () -> Unit) {
        if (_uiState.value.removingUid != null) return
        _uiState.value = _uiState.value.copy(removingUid = member.uid, removeError = null)
        viewModelScope.launch {
            repository.removeMember(kinfolkId, member.uid).fold(
                onSuccess = {
                    _uiState.value = _uiState.value.copy(
                        removingUid = null,
                        // "Suspended", not "removed": the server keeps the doc
                        // and the row stays in this list.
                        toast = "${member.label} is suspended on $householdName and signed out.",
                    )
                    onRemoved()
                    loadMembers()
                },
                onFailure = { err ->
                    _uiState.value = _uiState.value.copy(
                        removingUid = null,
                        removeError = "removeMember failed: ${err.message ?: "The member was not removed."}",
                    )
                },
            )
        }
    }

    fun clearToast() {
        _uiState.value = _uiState.value.copy(toast = null)
    }

    fun clearErrors() {
        _uiState.value = _uiState.value.copy(
            membersError = null,
            invitesError = null,
            permissionError = null,
            revokeError = null,
            removeError = null,
        )
    }
}

/**
 * True when this member's entitlements are theirs by ROLE, and the flags on
 * their member doc are inert.
 *
 * RULING (2026-08-04): "admin can edit permissions but not like primary's
 * access to full billing, home access, kin edit, etc. The screen makes it seem
 * like these account must needs can be turned off."
 *
 * They cannot. `requirePerm` and `hasKinfolkPerm` in
 * `mytribe/functions/src/lib/memberGate.ts` both answer for a PRIMARY before
 * they ever read `permissions`, so every flag on a primary is dead data, and
 * `setMemberPermissions` now refuses a primary target outright. The React
 * mirror is `permissionsFollowRole` in `auntieos-admin/src/api/members.ts`.
 */
internal fun permissionsFollowRole(role: MembersRepository.MemberRole): Boolean =
    role == MembersRepository.MemberRole.PRIMARY

/** Pure, so the optimistic flip is testable without a ViewModel. */
internal fun applyPermission(
    permissions: MembersRepository.MemberPermissions,
    key: MembersRepository.PermissionKey,
    value: Boolean,
): MembersRepository.MemberPermissions = when (key) {
    MembersRepository.PermissionKey.BILLING_FULL -> permissions.copy(billingFull = value)
    MembersRepository.PermissionKey.MESSAGING_DIRECT -> permissions.copy(messagingDirect = value)
    MembersRepository.PermissionKey.MESSAGING_GROUP -> permissions.copy(messagingGroup = value)
    MembersRepository.PermissionKey.KIN_EDIT -> permissions.copy(kinEdit = value)
    MembersRepository.PermissionKey.HOME_ACCESS -> permissions.copy(homeAccess = value)
}

/** Reads a flag off the permission shape by key. */
internal fun readPermission(
    permissions: MembersRepository.MemberPermissions,
    key: MembersRepository.PermissionKey,
): Boolean = when (key) {
    MembersRepository.PermissionKey.BILLING_FULL -> permissions.billingFull
    MembersRepository.PermissionKey.MESSAGING_DIRECT -> permissions.messagingDirect
    MembersRepository.PermissionKey.MESSAGING_GROUP -> permissions.messagingGroup
    MembersRepository.PermissionKey.KIN_EDIT -> permissions.kinEdit
    MembersRepository.PermissionKey.HOME_ACCESS -> permissions.homeAccess
}
