package com.tribetails.auntieos.ui.members

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.ShieldAlert
import com.tribetails.auntieos.data.repository.MembersRepository
import com.tribetails.auntieos.data.repository.inviteDate
import com.tribetails.auntieos.data.repository.inviteHandle
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieChip
import com.tribetails.auntieos.ui.components.AuntieDialog
import com.tribetails.auntieos.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.AuntieToggle
import com.tribetails.auntieos.ui.components.BottomBorderField
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * Household members and invites. (B1)
 *
 * The Android half of the surface whose React half is
 * `auntieos-admin/src/screens/HouseholdMembers.tsx`. Both call `listMembers`,
 * `listInvites`, `mintInvite`, `revokeInvite`, `setMemberPermissions` and
 * `removeMember`, and both follow `ui-ideas/auntieos-members-2026-05-27.html`
 * and `auntieos-invites-2026-05-27.html` for layout, minus those mocks' "no UI
 * today" banners, which stopped being true with this change, and minus their
 * sample data, which is placeholder by their own admission.
 *
 * PLACEMENT follows page-specs Decision 8 (LOCKED): members live under
 * Directory / Households / {household} / Members, not Settings, so this is
 * opened from the household profile and takes the household as context. There
 * is no free-text family-id field, unlike the invites mock: a typed tenant id
 * is a way to invite a stranger into the wrong family.
 *
 * The mocks' "invite to app" button is not repeated here. It already ships one
 * screen up, on the household profile
 * (`DirectoryViewModel.inviteKinfolkToPortal`), which is where this screen is
 * reached from. The empty roster says so rather than growing a second button
 * for the same call.
 */
@Composable
fun HouseholdMembersScreen(
    kinfolkId: String,
    kinfolkName: String,
    onBack: () -> Unit,
    viewModel: HouseholdMembersViewModel = remember(kinfolkId) {
        HouseholdMembersViewModel(kinfolkId = kinfolkId, householdName = kinfolkName)
    },
) {
    AuntieScreenScaffold(title = "Members and invites", onBack = onBack) {
        HouseholdMembersBody(kinfolkName = kinfolkName, viewModel = viewModel)
    }
}

@Composable
fun HouseholdMembersBody(
    kinfolkName: String,
    viewModel: HouseholdMembersViewModel,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val state by viewModel.uiState.collectAsState()

    var removeTarget by remember { mutableStateOf<MembersRepository.Member?>(null) }
    var inviteOpen by remember { mutableStateOf(false) }

    LaunchedEffect(Unit) { viewModel.load() }

    LazyColumn(
        contentPadding = PaddingValues(horizontal = dims.space4, vertical = dims.space4),
        verticalArrangement = Arrangement.spacedBy(dims.space4),
        modifier = Modifier.fillMaxSize(),
    ) {
        item {
            DenScreenHeading(
                kicker = "The Den · Directory",
                title = "Members and",
                accentTail = "invites.",
                subtitle = "Who can reach $kinfolkName in MyTribe, and what each of them may do.",
            )
        }

        // One banner per write, so a failed revoke is never mistaken for a
        // failed permission save.
        state.toast?.let { msg ->
            item {
                AuntieBanner(
                    tone = AuntieBannerTone.Success,
                    title = "Done",
                    onDismiss = { viewModel.clearToast() },
                ) { Text(msg, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary) }
            }
        }
        errorBannerItem(state.permissionError, "That permission did not save", viewModel)
        errorBannerItem(state.mintError, "The invite was not sent", viewModel)
        errorBannerItem(state.revokeError, "The invite was not revoked", viewModel)
        errorBannerItem(state.removeError, "The member was not removed", viewModel)

        item {
            DenPanel(
                title = "Members",
                subtitle = "Everyone with a MyTribe account on this household. " +
                    "KinTales access is locked on by the server and cannot be turned off here or anywhere.",
                trailing = {
                    if (state.membersLoaded) {
                        AuntieStatusPill(
                            label = "${state.members.size} on file",
                            tone = AuntieStatusTone.Neutral,
                        )
                    }
                },
            ) {
                when {
                    state.membersError != null -> {
                        // Never an empty state during a failure: an unreadable
                        // roster and an empty one must not look alike.
                        EmptyHint(state.membersError!!, error = true)
                        Spacer(Modifier.height(dims.space2))
                        GhostButton(label = "Retry", onClick = { viewModel.loadMembers() })
                    }
                    state.membersLoading && !state.membersLoaded -> EmptyHint("Loading members…")
                    state.membersLoaded && state.members.isEmpty() -> EmptyHint(
                        "Nobody has claimed this household yet. Send the portal invite from the " +
                            "household profile, and this list fills in once it is accepted.",
                    )
                    else -> Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
                        state.members.forEach { member ->
                            MemberBlock(
                                member = member,
                                savingPermission = state.savingPermission,
                                onToggle = { key, next -> viewModel.togglePermission(member, key, next) },
                                onRemove = { removeTarget = member },
                            )
                        }
                    }
                }
            }
        }

        item {
            DenPanel(
                title = "Invites",
                subtitle = "Every invite this household has been sent. An invite past its expiry " +
                    "reads Expired here from the moment it lapses, even though the nightly sweep " +
                    "has not stamped it yet.",
                trailing = {
                    PrimaryButton(label = "Send invite", onClick = { inviteOpen = true })
                },
            ) {
                when {
                    state.invitesError != null -> {
                        EmptyHint(state.invitesError!!, error = true)
                        Spacer(Modifier.height(dims.space2))
                        GhostButton(label = "Retry", onClick = { viewModel.loadInvites() })
                    }
                    state.invitesLoading && !state.invitesLoaded -> EmptyHint("Loading invites…")
                    state.invitesLoaded && state.invites.isEmpty() ->
                        EmptyHint("No invite has ever been sent to this household.")
                    else -> Column(verticalArrangement = Arrangement.spacedBy(dims.space4)) {
                        INVITE_GROUPS.forEach { group ->
                            val inGroup = state.invites.filter { it.effectiveStatus in group.statuses }
                            if (inGroup.isEmpty()) return@forEach
                            Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
                                AuntieFieldLabel(text = "${group.heading} (${inGroup.size})")
                                inGroup.forEach { invite ->
                                    InviteRow(
                                        invite = invite,
                                        revoking = state.revokingInviteId == invite.inviteId,
                                        revokeBusy = state.revokingInviteId != null,
                                        onRevoke = { viewModel.revokeInvite(invite) },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (inviteOpen) {
        SendInviteDialog(
            minting = state.minting,
            onDismiss = { if (!state.minting) inviteOpen = false },
            onSend = { email, label, role, perms ->
                viewModel.mintInvite(email, label, role, perms) { inviteOpen = false }
            },
        )
    }

    removeTarget?.let { target ->
        val busy = state.removingUid == target.uid
        AuntieDialog(
            visible = true,
            title = "Remove this member?",
            onDismiss = { if (!busy) removeTarget = null },
            maxWidth = 520.dp,
            hint = "This suspends the member. It does not delete their record.",
            footer = {
                GhostButton(
                    label = "Cancel",
                    onClick = { removeTarget = null },
                    enabled = !busy,
                    modifier = Modifier.weight(1f),
                )
                PrimaryButton(
                    label = if (busy) "Removing…" else "Remove",
                    onClick = { viewModel.removeMember(target) { removeTarget = null } },
                    enabled = !busy,
                    loading = busy,
                    modifier = Modifier.weight(1f),
                )
            },
        ) {
            Text(
                "${target.label} will be suspended on $kinfolkName and signed out of every " +
                    "device. The row stays in the list marked Suspended, and any invite they " +
                    "already accepted stays accepted.",
                style = AuntieTheme.typography.bodyMedium,
                color = c.textPrimary,
            )
            state.removeError?.let { msg ->
                Spacer(Modifier.height(dims.space3))
                AuntieBanner(tone = AuntieBannerTone.Error, title = "That did not work") {
                    Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
                }
            }
        }
    }
}

/** Adds one dismissible error banner to the list, or nothing when there is none. */
private fun androidx.compose.foundation.lazy.LazyListScope.errorBannerItem(
    message: String?,
    title: String,
    viewModel: HouseholdMembersViewModel,
) {
    if (message == null) return
    item {
        AuntieBanner(
            tone = AuntieBannerTone.Error,
            title = title,
            icon = Lucide.ShieldAlert,
            onDismiss = { viewModel.clearErrors() },
        ) {
            Text(
                message,
                style = AuntieTheme.typography.bodyMedium,
                color = AuntieTheme.colors.textPrimary,
            )
        }
    }
}

@Composable
private fun MemberBlock(
    member: MembersRepository.Member,
    savingPermission: String?,
    onToggle: (MembersRepository.PermissionKey, Boolean) -> Unit,
    onRemove: () -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    DenPanel(title = member.label, subtitle = member.uid) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(dims.space2),
            modifier = Modifier.fillMaxWidth(),
        ) {
            AuntieStatusPill(
                label = if (member.role == MembersRepository.MemberRole.PRIMARY) "PRIMARY" else "SECONDARY",
                tone = if (member.role == MembersRepository.MemberRole.PRIMARY) {
                    AuntieStatusTone.Purple
                } else {
                    AuntieStatusTone.Teal
                },
            )
            AuntieStatusPill(
                label = member.status.name,
                tone = memberStatusTone(member.status),
                showDot = true,
            )
            member.secondaryLabel?.let {
                AuntieStatusPill(label = it, tone = AuntieStatusTone.Neutral)
            }
            Spacer(Modifier.weight(1f))
            GhostButton(label = "Remove", onClick = onRemove)
        }

        Spacer(Modifier.height(dims.space3))

        PERMISSION_ROWS.forEach { row ->
            val busy = savingPermission == row.key?.let { "${member.uid}:${it.name}" }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(dims.space3),
                modifier = Modifier.fillMaxWidth().padding(vertical = dims.space2),
            ) {
                Column(Modifier.weight(1f)) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(dims.space2),
                    ) {
                        Text(
                            row.label,
                            style = AuntieTheme.typography.bodyMedium,
                            color = c.textPrimary,
                        )
                        if (row.key == null) {
                            AuntieStatusPill(label = "LOCKED ON", tone = AuntieStatusTone.Teal)
                        }
                    }
                    Text(row.description, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
                if (busy) {
                    Text("Saving…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    Spacer(Modifier.width(dims.space2))
                }
                AuntieToggle(
                    // A null key is `kintales_only`, which the server refuses to
                    // change, so it renders on and disabled rather than as a
                    // control that silently no-ops.
                    checked = row.key?.let { readPermission(member.permissions, it) } ?: true,
                    onCheckedChange = { next -> row.key?.let { onToggle(it, next) } },
                    enabled = row.key != null && savingPermission == null,
                )
            }
        }
    }
}

@Composable
private fun InviteRow(
    invite: MembersRepository.Invite,
    revoking: Boolean,
    revokeBusy: Boolean,
    onRevoke: () -> Unit,
) {
    val dims = AuntieTheme.dims
    Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
        androidx.compose.foundation.layout.Box {
            com.tribetails.auntieos.ui.components.AuntieEntityRow(
                title = invite.invitedEmail,
                subtitle = inviteMetaLine(invite),
                trailing = {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(dims.space2),
                    ) {
                        AuntieStatusPill(
                            label = inviteStatusLabel(invite.effectiveStatus),
                            tone = inviteStatusTone(invite.effectiveStatus),
                        )
                        // Revoke is offered ONLY when the server says the invite
                        // is still redeemable. Offering it on a dead invite
                        // would be a button that fails when tapped.
                        if (invite.redeemable) {
                            GhostButton(
                                label = if (revoking) "Revoking…" else "Revoke",
                                onClick = onRevoke,
                                enabled = !revokeBusy,
                            )
                        }
                    }
                },
            )
        }
    }
}

@Composable
private fun SendInviteDialog(
    minting: Boolean,
    onDismiss: () -> Unit,
    onSend: (
        email: String,
        label: String,
        role: MembersRepository.MemberRole,
        permissions: MembersRepository.MemberPermissions,
    ) -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    var email by remember { mutableStateOf("") }
    var label by remember { mutableStateOf("") }
    var role by remember { mutableStateOf(MembersRepository.MemberRole.SECONDARY) }
    var perms by remember { mutableStateOf(DEFAULT_INVITE_PERMISSIONS) }

    val emailReady = email.trim().isNotBlank() && email.contains("@")
    val labelTooLong = label.trim().length > MembersRepository.SECONDARY_LABEL_MAX

    AuntieDialog(
        visible = true,
        title = "Send an invite",
        onDismiss = onDismiss,
        maxWidth = 620.dp,
        hint = "Emails a claim link to one person and adds them to this household when they " +
            "accept. The link expires in ${MembersRepository.INVITE_TTL_DAYS} days.",
        footer = {
            GhostButton(
                label = "Cancel",
                onClick = onDismiss,
                enabled = !minting,
                modifier = Modifier.weight(1f),
            )
            PrimaryButton(
                label = if (minting) "Sending…" else "Send invite",
                onClick = { onSend(email, label, role, perms) },
                enabled = !minting && emailReady && !labelTooLong,
                loading = minting,
                modifier = Modifier.weight(1f),
            )
        },
    ) {
        BottomBorderField(
            value = email,
            onValueChange = { email = it },
            label = "Email address",
            placeholder = "name@example.com",
            required = true,
            enabled = !minting,
            keyboardType = KeyboardType.Email,
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            "Lowercased and matched against the accepting account. Someone signing in with a " +
                "different address cannot use this link.",
            style = AuntieTheme.typography.bodySmall,
            color = c.textFaint,
        )

        Spacer(Modifier.height(dims.space3))
        BottomBorderField(
            value = label,
            onValueChange = { label = it },
            label = "Label",
            placeholder = MembersRepository.DEFAULT_SECONDARY_LABEL,
            enabled = !minting,
            isError = labelTooLong,
            errorMessage = if (labelTooLong) {
                "The label must be ${MembersRepository.SECONDARY_LABEL_MAX} characters or fewer."
            } else {
                null
            },
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            "${label.trim().length} / ${MembersRepository.SECONDARY_LABEL_MAX}. Optional, and the " +
                "server strips brackets and dashes, so the saved label can differ from what you type.",
            style = AuntieTheme.typography.bodySmall,
            color = c.textFaint,
        )

        Spacer(Modifier.height(dims.space3))
        AuntieFieldLabel(text = "Role")
        Row(horizontalArrangement = Arrangement.spacedBy(dims.space2)) {
            MembersRepository.MemberRole.entries.forEach { option ->
                AuntieChip(
                    label = if (option == MembersRepository.MemberRole.SECONDARY) "Secondary" else "Primary",
                    selected = role == option,
                    onClick = { role = option },
                )
            }
        }
        Text(
            "Secondary is a co-parent on an existing household. Primary claims the household " +
                "account itself.",
            style = AuntieTheme.typography.bodySmall,
            color = c.textFaint,
        )

        Spacer(Modifier.height(dims.space3))
        AuntieFieldLabel(text = "Starting permissions")
        PERMISSION_ROWS.forEach { row ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(dims.space3),
                modifier = Modifier.fillMaxWidth().padding(vertical = dims.space2),
            ) {
                Column(Modifier.weight(1f)) {
                    Text(row.label, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                    Text(row.description, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
                AuntieToggle(
                    checked = row.key?.let { readPermission(perms, it) } ?: true,
                    onCheckedChange = { next -> row.key?.let { perms = applyPermission(perms, it, next) } },
                    enabled = row.key != null && !minting,
                )
            }
        }
    }
}

// ── pure display helpers, unit-tested directly ──────────────────────────────

/**
 * One permission row. A null [key] is `kintales_only`, which no callable on any
 * path accepts as an argument, so it has no wire key to send and renders locked.
 */
internal data class PermissionRow(
    val key: MembersRepository.PermissionKey?,
    val label: String,
    val description: String,
    // `adminOnly` used to live here, set on billing_full, and painted an
    // "ADMIN ONLY" pill claiming the household's own PRIMARY could not move that
    // flag. Per the operator ruling they can. Removed rather than relabelled:
    // billing_full was the only row that carried it.
)

/** Order is the order rendered. Mirrors `PERMISSION_META` in the React mirror. */
internal val PERMISSION_ROWS: List<PermissionRow> = listOf(
    PermissionRow(
        MembersRepository.PermissionKey.BILLING_FULL,
        "Full billing",
        "Full access to invoices and payment methods. The household PRIMARY can " +
            "grant this too; every change is audited.",
    ),
    PermissionRow(
        MembersRepository.PermissionKey.MESSAGING_DIRECT,
        "Direct messaging",
        "One to one messages with the Auntie.",
    ),
    PermissionRow(
        MembersRepository.PermissionKey.MESSAGING_GROUP,
        "Group messaging",
        "Takes part in the household group thread.",
    ),
    PermissionRow(
        MembersRepository.PermissionKey.KIN_EDIT,
        "Edit kin",
        "Adds or edits the household pet records.",
    ),
    PermissionRow(
        MembersRepository.PermissionKey.HOME_ACCESS,
        "Home access",
        "Sees the household home details, including entry notes.",
    ),
    PermissionRow(
        null,
        "KinTales feed",
        "Always reads the household KinTales feed. Locked on by the server.",
    ),
)

/**
 * A new secondary can talk to the Auntie and read the feed, and nothing else.
 * Billing, kin edits and home access are grants the operator makes on purpose.
 * `kintalesOnly` is true because the server forces it true anyway.
 */
internal val DEFAULT_INVITE_PERMISSIONS = MembersRepository.MemberPermissions(
    billingFull = false,
    messagingDirect = true,
    messagingGroup = true,
    kinEdit = false,
    kintalesOnly = true,
    homeAccess = false,
)

internal data class InviteGroup(
    val heading: String,
    val statuses: List<MembersRepository.InviteStatus>,
)

/** The order the invites mock stacks them in. */
internal val INVITE_GROUPS: List<InviteGroup> = listOf(
    InviteGroup(
        "Pending",
        listOf(MembersRepository.InviteStatus.PENDING, MembersRepository.InviteStatus.EMAIL_SENT),
    ),
    InviteGroup("Accepted", listOf(MembersRepository.InviteStatus.ACCEPTED)),
    InviteGroup("Expired", listOf(MembersRepository.InviteStatus.EXPIRED)),
    InviteGroup("Revoked", listOf(MembersRepository.InviteStatus.REVOKED)),
)

internal fun memberStatusTone(status: MembersRepository.MemberStatus): AuntieStatusTone = when (status) {
    MembersRepository.MemberStatus.ACTIVE -> AuntieStatusTone.Success
    MembersRepository.MemberStatus.INVITED -> AuntieStatusTone.Warning
    MembersRepository.MemberStatus.SUSPENDED -> AuntieStatusTone.Error
}

internal fun inviteStatusTone(status: MembersRepository.InviteStatus): AuntieStatusTone = when (status) {
    MembersRepository.InviteStatus.ACCEPTED -> AuntieStatusTone.Success
    MembersRepository.InviteStatus.PENDING,
    MembersRepository.InviteStatus.EMAIL_SENT -> AuntieStatusTone.Warning
    MembersRepository.InviteStatus.REVOKED -> AuntieStatusTone.Error
    MembersRepository.InviteStatus.EXPIRED -> AuntieStatusTone.Muted
}

internal fun inviteStatusLabel(status: MembersRepository.InviteStatus): String =
    if (status == MembersRepository.InviteStatus.EMAIL_SENT) "Email sent" else {
        status.name.first() + status.name.drop(1).lowercase()
    }

/**
 * The one-line invite provenance. Only dates the server actually returned are
 * shown; a missing timestamp is omitted rather than filled with today. The
 * invite id appears truncated, never as a claim URL: the full id is the token.
 */
internal fun inviteMetaLine(invite: MembersRepository.Invite): String {
    val parts = mutableListOf<String>()
    val sent = inviteDate(invite.sentToInviteeAt)
    val created = inviteDate(invite.createdAt)
    when {
        sent != null -> parts += "Sent $sent"
        created != null -> parts += "Created $created"
    }
    if (invite.effectiveStatus == MembersRepository.InviteStatus.REVOKED) {
        inviteDate(invite.revokedAt)?.let { parts += "revoked $it" }
    } else {
        inviteDate(invite.expiresAt)?.let {
            parts += if (invite.effectiveStatus == MembersRepository.InviteStatus.EXPIRED) {
                "expired $it"
            } else {
                "expires $it"
            }
        }
    }
    parts += inviteHandle(invite.inviteId)
    return parts.joinToString(" · ")
}
