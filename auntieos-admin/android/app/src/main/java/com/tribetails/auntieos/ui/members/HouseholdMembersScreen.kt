package com.tribetails.auntieos.ui.members

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.ShieldAlert
import com.tribetails.auntieos.data.repository.MembersRepository
import com.tribetails.auntieos.data.repository.inviteDate
import com.tribetails.auntieos.data.repository.inviteHandle
import com.tribetails.auntieos.ui.components.AuntieAvatar
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieDialog
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.AuntieToggle
import com.tribetails.auntieos.ui.components.DenCrumb
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.GlassSurface
import com.tribetails.auntieos.ui.components.LoadingHint
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * Household members and invites. (B1)
 *
 * The Android half of the surface whose React half is
 * `auntieos-admin/src/screens/HouseholdMembers.tsx`. Both call `listMembers`,
 * `listInvites`, `revokeInvite`, `setMemberPermissions` and `removeMember`,
 * and both follow `ui-ideas/auntieos-members-2026-05-27.html` and
 * `auntieos-invites-2026-05-27.html` for layout, minus those mocks' "no UI
 * today" banners, which stopped being true with this change, and minus their
 * sample data, which is placeholder by their own admission.
 *
 * THE SHAPE IS THE MOCK'S (#755). The kit hero band carries the household's
 * crest, its name, and the mock's mono `.where` line (family id and the
 * member counts). Under it the roster is split by role: a Primary contact
 * panel with the mock's `role: PRIMARY` note, a Secondary contacts panel with
 * `N of role: SECONDARY`, then Invites. Every member is the mock's `.member`
 * block: a 58dp circle, the name in Fraunces, a compact role capsule and a
 * compact status capsule, the uid in mono, and for a secondary the label
 * (read-only, see below) and the permission list under a hairline with the
 * mock's "Locked on" chip beside the kintales switch. A primary carries the
 * mock's footnote capsule, "all permissions granted by role", and no rows.
 * Before this pass each member was a `DenPanel` nested inside the Members
 * `DenPanel`, which the kit's own note says no screen does.
 *
 * PLACEMENT follows page-specs Decision 8 (LOCKED): members live under
 * Directory / Households / {household} / Members, not Settings, so this is
 * opened from the household profile and takes the household as context. There
 * is no free-text family-id field, unlike the invites mock: a typed tenant id
 * is a way to invite a stranger into the wrong family.
 *
 * THE HERO CARRIES NO ACTION ON ANDROID. The mock's primary action is the
 * admin's one invite, and on this client that button ships one screen up, on
 * the household profile (`DirectoryViewModel.inviteKinfolkToPortal`), which
 * is where this screen is reached from; [MembersRepository] leaves it out on
 * purpose and the empty roster says where it is. The mock's "Swap primary" is
 * `executePrimaryRecovery`, which the web screen offers (#378, #426) and this
 * client has never carried: a pre-existing gap, reported rather than widened
 * by a sweep.
 *
 * WHO INVITES WHOM (ruling, 2026-08-04). The admin invites the PRIMARY. The
 * PRIMARY invites the secondary, from MyTribe, and this screen offers no way to
 * do it on their behalf: the mock's "Add secondary contact" is not built. It
 * also offers no typed-address way to invite the primary any more: "Invite a
 * primary by email" sent the same claim link the household profile button
 * already sends, and the operator rejected that use case (issue #684).
 * `MembersRepository.mintInvite` stays registered (PRIMARY-only) with no
 * caller left in this screen.
 *
 * Two more of the mock's controls are PRIMARY-only on the server and so are
 * not offered to an admin: the editable `secondaryLabel` input
 * (`updateMemberLabel` calls `requirePrimary`) and "Swap contact info"
 * (`swapPrimaryContact` edits the CALLER's own client record). The label is
 * shown read-only in the mock's shape.
 *
 * WHAT A PRIMARY MAY LOSE: nothing. Their entitlements are inherent to the role
 * (`requirePerm` answers for a PRIMARY before it reads the flags), so a primary
 * renders as granted-by-role rather than as five switches. This screen drew
 * those switches, which made billing, home access and kin edit look revocable
 * when the writes behind them changed nothing any enforcement path reads.
 * `permissionsFollowRole` is the check, and `setMemberPermissions` now refuses
 * a primary target too.
 */
@Composable
fun HouseholdMembersScreen(
    kinfolkId: String,
    kinfolkName: String,
    onBack: () -> Unit,
    /**
     * All the way out to the Directory list, for the breadcrumb's first step.
     * [onBack] pops ONE entry, to the household profile this was opened from,
     * so the trail needs its own way past that. Defaults to [onBack] so a
     * caller that has no deeper stack still gets a step that does something.
     */
    onDirectory: () -> Unit = onBack,
    viewModel: HouseholdMembersViewModel = remember(kinfolkId) {
        HouseholdMembersViewModel(kinfolkId = kinfolkId, householdName = kinfolkName)
    },
) {
    AuntieScreenScaffold(title = "Members and invites", onBack = onBack) {
        HouseholdMembersBody(
            kinfolkName = kinfolkName,
            viewModel = viewModel,
            onBack = onBack,
            onDirectory = onDirectory,
        )
    }
}

/** The mock's `.member` corner, and the web `--radius-18`. */
private val MemberBlockShape = RoundedCornerShape(18.dp)

@Composable
fun HouseholdMembersBody(
    kinfolkName: String,
    viewModel: HouseholdMembersViewModel,
    onBack: () -> Unit = {},
    onDirectory: () -> Unit = {},
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val state by viewModel.uiState.collectAsState()

    var removeTarget by remember { mutableStateOf<MembersRepository.Member?>(null) }

    LaunchedEffect(Unit) { viewModel.load() }

    val primaries = state.members.filter { it.role == MembersRepository.MemberRole.PRIMARY }
    val secondaries = state.members.filter { it.role == MembersRepository.MemberRole.SECONDARY }

    LazyColumn(
        contentPadding = PaddingValues(horizontal = dims.space4, vertical = dims.space4),
        verticalArrangement = Arrangement.spacedBy(dims.space4),
        modifier = Modifier.fillMaxSize(),
    ) {
        item {
            DenScreenHeading(
                // The kicker read "The Den · Directory", word for word what
                // DirectoryScreen two levels up says, so it could not tell an
                // operator which of the two they had open. The trail takes its
                // place, per `ui-ideas/auntieos-members-2026-05-27.html`.
                kicker = "The Den · Directory",
                crumbs = listOf(
                    DenCrumb("Directory", onDirectory),
                    DenCrumb(kinfolkName, onBack),
                    DenCrumb("Members and invites"),
                ),
                // The mock's hero names the HOUSEHOLD; the trail already says
                // Members. The crest is the mock's 72dp tile.
                title = kinfolkName,
                subtitle = "Who can reach $kinfolkName in MyTribe, and what each of them may do. " +
                    "The portal invite lives on the household profile.",
                leading = {
                    AuntieAvatar(
                        initials = householdInitial(kinfolkName),
                        gradientSeed = viewModel.kinfolkId,
                        size = 72.dp,
                        shape = RoundedCornerShape(22.dp),
                        ring = false,
                    )
                },
                content = {
                    // The mock's `.where`: mono, 13.5, dim, under the name.
                    Text(
                        text = whereLine(viewModel.kinfolkId, state),
                        style = AuntieTheme.typography.mono.copy(fontSize = 13.5.sp, letterSpacing = 0.3.sp),
                        color = c.textDim,
                    )
                },
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
        errorBannerItem(state.revokeError, "The invite was not revoked", viewModel)
        errorBannerItem(state.removeError, "The member was not removed", viewModel)

        item {
            DenPanel(
                title = "Primary contact",
                meta = "role: PRIMARY",
                subtitle = "The household account owner. Held by role, not by setting: full " +
                    "billing, home access, kin edits and messaging come with being the primary, " +
                    "and the server reads the role rather than these flags, so there is nothing " +
                    "here to switch off.",
            ) {
                when {
                    state.membersError != null -> {
                        // Never an empty state during a failure: an unreadable
                        // roster and an empty one must not look alike.
                        EmptyHint(state.membersError!!, error = true)
                        Spacer(Modifier.height(dims.space2))
                        GhostButton(label = "Retry", onClick = { viewModel.loadMembers() })
                    }
                    state.membersLoading && !state.membersLoaded -> LoadingHint("Loading members…")
                    state.membersLoaded && state.members.isEmpty() -> EmptyHint(
                        "Nobody has claimed this household yet. Send the portal invite from the " +
                            "household profile, and this fills in once it is accepted.",
                    )
                    state.membersLoaded && primaries.isEmpty() -> EmptyHint(
                        "There is no active primary. Send the portal invite from the household " +
                            "profile, and whoever accepts becomes the primary.",
                    )
                    else -> Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        primaries.forEach { member ->
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
                title = "Secondary contacts",
                meta = if (state.membersLoaded) "${secondaries.size} of role: SECONDARY" else null,
                subtitle = "Household members the primary invited from MyTribe. Each carries a " +
                    "label and a permission set you can edit here. KinTales access is locked on " +
                    "by the server for everyone.",
            ) {
                when {
                    // The failure is named once, in the panel above. This one
                    // only says it is unknown.
                    state.membersError != null -> EmptyHint(
                        "Secondary contacts unavailable while the member list is failing.",
                        error = true,
                    )
                    state.membersLoading && !state.membersLoaded ->
                        LoadingHint("Loading secondary contacts…")
                    state.membersLoaded && secondaries.isEmpty() ->
                        EmptyHint("No secondary contacts yet. The primary invites them from MyTribe.")
                    else -> Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                        secondaries.forEach { member ->
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
                meta = if (state.invitesLoaded) "${state.invites.size} total" else null,
                subtitle = "Every invite this household has been sent. An invite past its expiry " +
                    "reads Expired here from the moment it lapses, even though the nightly sweep " +
                    "has not stamped it yet.",
            ) {
                when {
                    state.invitesError != null -> {
                        EmptyHint(state.invitesError!!, error = true)
                        Spacer(Modifier.height(dims.space2))
                        GhostButton(label = "Retry", onClick = { viewModel.loadInvites() })
                    }
                    state.invitesLoading && !state.invitesLoaded -> LoadingHint("Loading invites…")
                    state.invitesLoaded && state.invites.isEmpty() ->
                        EmptyHint("No invite has ever been sent to this household.")
                    else -> Column(verticalArrangement = Arrangement.spacedBy(22.dp)) {
                        INVITE_GROUPS.forEach { group ->
                            val inGroup = state.invites.filter { it.effectiveStatus in group.statuses }
                            if (inGroup.isEmpty()) return@forEach
                            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                // The invites mock's `.sec h3`: the serif heading
                                // and the mono status note beside it.
                                Row(
                                    verticalAlignment = Alignment.Bottom,
                                    horizontalArrangement = Arrangement.spacedBy(9.dp),
                                    modifier = Modifier.padding(bottom = 1.dp),
                                ) {
                                    Text(
                                        text = group.heading,
                                        style = AuntieTheme.typography.headlineSmall.copy(fontSize = 19.sp),
                                        color = c.textPrimary,
                                        modifier = Modifier.semantics { heading() },
                                    )
                                    Text(
                                        text = inviteGroupNote(group, inGroup.size),
                                        style = AuntieTheme.typography.labelSmall,
                                        color = c.textDim,
                                    )
                                }
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

/**
 * The mock's `.member` block, and its `.primecard` (the same identity row with
 * the footnote capsule instead of the permission list): the second surface on
 * a hairline at 18dp, 18dp inside. Not a panel and not nested in one.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MemberBlock(
    member: MembersRepository.Member,
    savingPermission: String?,
    onToggle: (MembersRepository.PermissionKey, Boolean) -> Unit,
    onRemove: () -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val byRole = permissionsFollowRole(member.role)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(MemberBlockShape)
            .background(c.surface2)
            .border(dims.borderHairline, c.border, MemberBlockShape)
            .padding(18.dp),
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(14.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            // The mock's `.who .photo`: a 58dp ringed circle. A member has no
            // photo field, so the kit avatar's letter on its seeded gradient
            // stands in.
            AuntieAvatar(
                initials = member.label.take(1),
                gradientSeed = member.uid,
                size = 58.dp,
            )
            Column(Modifier.weight(1f)) {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        text = member.label,
                        style = AuntieTheme.typography.headlineSmall.copy(fontSize = 19.sp),
                        color = c.textPrimary,
                        modifier = Modifier.align(Alignment.CenterVertically),
                    )
                    AuntieStatusPill(
                        label = roleLabel(member.role),
                        tone = roleTone(member.role),
                        mono = true,
                        compact = true,
                        modifier = Modifier.align(Alignment.CenterVertically),
                    )
                    AuntieStatusPill(
                        label = memberStatusLabel(member.status),
                        tone = memberStatusTone(member.status),
                        mono = true,
                        compact = true,
                        showDot = true,
                        modifier = Modifier.align(Alignment.CenterVertically),
                    )
                }
                Spacer(Modifier.height(2.dp))
                // The mock's `.contact`: mono and dim. The uid is what this
                // screen has where the mock shows an email and a phone; the
                // name above is the email.
                Text(
                    text = member.uid,
                    style = AuntieTheme.typography.mono.copy(fontSize = 12.5.sp),
                    color = c.textDim,
                )
                val label = member.secondaryLabel?.trim().orEmpty()
                if (member.role == MembersRepository.MemberRole.SECONDARY && label.isNotEmpty()) {
                    Spacer(Modifier.height(4.dp))
                    // The mock's `.labelwrap`, read-only: `updateMemberLabel`
                    // is PRIMARY-only on the server.
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(dims.space2),
                    ) {
                        Text(
                            text = "SECONDARYLABEL",
                            style = AuntieTheme.typography.labelSmall,
                            color = c.textDim,
                        )
                        Text(
                            text = label,
                            style = AuntieTheme.typography.labelMedium,
                            color = c.textPrimary,
                            modifier = Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .background(c.surface)
                                .border(dims.borderHairline, c.border, RoundedCornerShape(8.dp))
                                .padding(horizontal = 9.dp, vertical = 4.dp),
                        )
                    }
                }
            }
            GhostButton(label = "Remove", onClick = onRemove)
        }

        if (byRole) {
            // The mock's `.cbar` footnote under the primary card. One capsule
            // that reads as state, where a secondary's rows carry controls.
            Spacer(Modifier.height(14.dp))
            AuntieStatusPill(
                label = "All permissions granted by role",
                tone = AuntieStatusTone.Success,
                mono = true,
                compact = true,
            )
            return@Column
        }

        Spacer(Modifier.height(16.dp))
        HorizontalDivider(color = c.borderSoft, thickness = dims.borderHairline)
        Spacer(Modifier.height(14.dp))
        // The mock's `.permhdr`.
        Text(
            text = "PERMISSIONS",
            style = AuntieTheme.typography.labelSmall.copy(fontSize = 10.sp, letterSpacing = 1.2.sp),
            color = c.textDim,
        )
        PERMISSION_ROWS.forEachIndexed { index, row ->
            val busy = savingPermission == row.key?.let { "${member.uid}:${it.name}" }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(dims.space3),
                modifier = Modifier.fillMaxWidth().padding(vertical = 11.dp),
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        text = row.label,
                        style = AuntieTheme.typography.mono.copy(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                        color = c.textPrimary,
                    )
                    Text(row.description, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
                if (busy) {
                    Text("Saving…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    Spacer(Modifier.width(dims.space2))
                }
                if (row.key == null) {
                    // The mock's lock chip, beside the locked switch.
                    AuntieStatusPill(
                        label = "Locked on",
                        tone = AuntieStatusTone.Teal,
                        mono = true,
                        compact = true,
                    )
                }
                AuntieToggle(
                    // A null key is `kintales_only`, which the server refuses
                    // to change, so it renders on and disabled rather than as
                    // a control that silently no-ops.
                    checked = row.key?.let { readPermission(member.permissions, it) } ?: true,
                    onCheckedChange = { next -> row.key?.let { onToggle(it, next) } },
                    enabled = row.key != null && savingPermission == null,
                )
            }
            if (index < PERMISSION_ROWS.lastIndex) {
                HorizontalDivider(color = c.borderSoft, thickness = dims.borderHairline)
            }
        }
    }
}

/**
 * The invites mock's `.iv`, as the admin-wide Invites screen draws it: a 4dp
 * tone stripe, a 42dp circle, the address, the provenance line, the pills.
 * Revoke sits at the right, and ONLY while the server says the invite is
 * still redeemable: a Revoke on a dead invite is a button that fails when
 * tapped.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun InviteRow(
    invite: MembersRepository.Invite,
    revoking: Boolean,
    revokeBusy: Boolean,
    onRevoke: () -> Unit,
) {
    val c = AuntieTheme.colors
    val tone = invitePillTone(invite.effectiveStatus)
    val label = invite.secondaryLabel?.trim().orEmpty()
    GlassSurface(cornerRadius = 16.dp, modifier = Modifier.fillMaxWidth()) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(13.dp),
            // Intrinsic height so the stripe can run the row's full height, the
            // mock's `align-self: stretch`.
            modifier = Modifier.fillMaxWidth().height(IntrinsicSize.Min).padding(14.dp),
        ) {
            Box(
                modifier = Modifier
                    .width(4.dp)
                    .fillMaxHeight()
                    .heightIn(min = 54.dp)
                    .clip(RoundedCornerShape(999.dp))
                    .background(tone.color(c)),
            )
            AuntieAvatar(
                initials = invite.invitedEmail.take(1),
                size = 42.dp,
                gradientSeed = invite.invitedEmail,
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = invite.invitedEmail,
                    style = AuntieTheme.typography.titleMedium,
                    color = c.textPrimary,
                )
                Spacer(Modifier.height(3.dp))
                Text(
                    text = inviteMetaLine(invite),
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
                Spacer(Modifier.height(8.dp))
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    AuntieStatusPill(
                        label = inviteStatusLabel(invite.effectiveStatus),
                        tone = tone,
                        mono = true,
                        compact = true,
                    )
                    AuntieStatusPill(
                        label = roleLabel(invite.proposedRole),
                        tone = AuntieStatusTone.Purple,
                        mono = true,
                        compact = true,
                    )
                    if (label.isNotEmpty()) {
                        AuntieStatusPill(
                            label = label,
                            tone = AuntieStatusTone.Neutral,
                            mono = true,
                            compact = true,
                        )
                    }
                }
            }
            if (invite.redeemable) {
                GhostButton(
                    label = if (revoking) "Revoking…" else "Revoke",
                    onClick = onRevoke,
                    enabled = !revokeBusy,
                )
            }
        }
    }
}

// `SendInviteDialog` lived here: the typed-email "Invite a primary by email"
// dialog, one address, one grant, a PRIMARY claim. Removed per the operator's
// ruling on issue #684, "Invite a primary by email is unnecessary. We already
// have the Portal Access button": that button, on the household profile
// (`DirectoryViewModel.inviteKinfolkToPortal`), already sends the same claim
// link. `MembersRepository.mintInvite` stays registered (PRIMARY-only, per
// the 2026-08-04 invite ruling) with no caller left in this screen.

// ── pure display helpers, unit-tested directly ──────────────────────────────

/**
 * The mock's crest letter: "W" for "the Wrens". A leading article is skipped
 * so a household named "the Walls" reads W rather than T; an id-only fallback
 * name keeps its first letter, which is honest if not pretty.
 */
internal fun householdInitial(name: String): String {
    val trimmed = name.trim().replace(Regex("^the\\s+", RegexOption.IGNORE_CASE), "")
    val source = if (trimmed.isEmpty()) name.trim() else trimmed
    return source.take(1).uppercase()
}

/**
 * The mock's `.where` line under the household name: `familyId: fam_7Qk2 · 3
 * members · 1 PRIMARY, 2 SECONDARY`. Counts are by ROLE, which is what the
 * two panels are split by, and they are only written once the roster has been
 * read: before that the line is the id alone, never "0 members".
 */
internal fun whereLine(kinfolkId: String, state: HouseholdMembersUiState): String {
    val head = "familyId: $kinfolkId"
    if (!state.membersLoaded) return head
    val total = state.members.size
    val primary = state.members.count { it.role == MembersRepository.MemberRole.PRIMARY }
    val noun = if (total == 1) "member" else "members"
    return "$head · $total $noun · $primary PRIMARY, ${total - primary} SECONDARY"
}

/** The invites mock's `.sec h3 .ct`: the wire statuses and the count. */
internal fun inviteGroupNote(group: InviteGroup, count: Int): String =
    group.statuses.joinToString(" / ") { it.name } + " · $count"

/** "Active" from ACTIVE. The mock's LED text is title case. */
internal fun memberStatusLabel(status: MembersRepository.MemberStatus): String =
    status.name.first() + status.name.drop(1).lowercase()

/** The mock's `.role` chip: PRIMARY in purple, SECONDARY in teal. */
internal fun roleTone(role: MembersRepository.MemberRole): AuntieStatusTone =
    if (role == MembersRepository.MemberRole.PRIMARY) AuntieStatusTone.Purple else AuntieStatusTone.Teal

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

// DEFAULT_INVITE_PERMISSIONS lived here: the starting permission set the admin
// invite form offered for a new SECONDARY. It went with the form. The admin
// invites the PRIMARY, whose entitlements are the role's, and the server writes
// FULL_PERMISSIONS for that invite without asking the client.

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

/**
 * The members mock's `.status` LED: active in teal, invited in orange.
 * Suspended is not drawn there; coral is the app's colour for a member who
 * has been removed. Mirrors `memberStatusTone` in `src/api/members.ts`.
 */
internal fun memberStatusTone(status: MembersRepository.MemberStatus): AuntieStatusTone = when (status) {
    MembersRepository.MemberStatus.ACTIVE -> AuntieStatusTone.Teal
    MembersRepository.MemberStatus.INVITED -> AuntieStatusTone.Orange
    MembersRepository.MemberStatus.SUSPENDED -> AuntieStatusTone.Error
}

/**
 * The invites mock's tints, and the same map as [invitePillTone] on the
 * admin-wide Invites screen: pending and email sent in orange, accepted in
 * teal, revoked in coral, expired in the muted grey. Mirrors
 * `inviteStatusTone` in `src/api/members.ts`.
 */
internal fun inviteStatusTone(status: MembersRepository.InviteStatus): AuntieStatusTone = when (status) {
    MembersRepository.InviteStatus.ACCEPTED -> AuntieStatusTone.Teal
    MembersRepository.InviteStatus.PENDING,
    MembersRepository.InviteStatus.EMAIL_SENT -> AuntieStatusTone.Orange
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
