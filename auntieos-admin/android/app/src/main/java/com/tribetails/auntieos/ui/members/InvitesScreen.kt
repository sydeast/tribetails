package com.tribetails.auntieos.ui.members

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tribetails.auntieos.data.repository.MembersRepository
import com.tribetails.auntieos.data.repository.inviteDate
import com.tribetails.auntieos.data.repository.inviteHandle
import com.tribetails.auntieos.ui.components.AuntieAvatar
import com.tribetails.auntieos.ui.components.AuntieChipGroup
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.GlassSurface
import com.tribetails.auntieos.ui.components.color
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * Invites, across every household. The Android half of
 * `auntieos-admin/src/screens/Invites.tsx`; the two move together.
 *
 * WHAT WAS MISSING. [HouseholdMembersScreen] beside this one is always about
 * ONE household, reached from that household's profile, because `listInvites`
 * takes a `familyId`. The operator's real question, "who did we invite who
 * never came in", therefore meant opening every household by hand. This screen
 * is that question, answered by one `listAllInvites` read.
 *
 * IT IS A READ. Per the invite ruling (CLAUDE.md, "WHO INVITES WHOM",
 * 2026-08-04) the admin's only invite is inviting a PRIMARY to the portal, and
 * both callables that do it are household-scoped; the PRIMARY invites the
 * secondary from MyTribe. So there is no Send here, no Revoke, and no
 * permission control: an admin-WIDE surface has no household to act on.
 * Tapping a row opens that household's own members-and-invites screen, where
 * every action already lives.
 *
 * THE SHAPE IS THE MOCK'S (`ui-ideas/auntieos-invites-2026-05-27.html`, #755).
 * Sections sit on the ground under a serif heading with a mono status note,
 * and every invite is one row on the glass: a tone stripe down the left edge,
 * a framed circle, the address in bold, a dim provenance line, then the pills.
 * No panel wraps the sections, because the mock draws none.
 *
 * THE INVITE ID IS A BEARER TOKEN. The claim link is `?invite=<inviteId>`, so
 * the document id doubles as the secret. Rows show `inviteHandle`'s truncated
 * form only, and never a claim URL.
 */
@Composable
fun InvitesScreen(
    onBack: () -> Unit,
    onOpenHousehold: (kinfolkId: String, householdName: String) -> Unit,
    viewModel: InvitesViewModel = remember { InvitesViewModel() },
) {
    AuntieScreenScaffold(title = "Invites", onBack = onBack) {
        InvitesBody(viewModel = viewModel, onOpenHousehold = onOpenHousehold)
    }
}

@Composable
fun InvitesBody(
    viewModel: InvitesViewModel,
    onOpenHousehold: (kinfolkId: String, householdName: String) -> Unit,
) {
    val dims = AuntieTheme.dims
    val state by viewModel.uiState.collectAsState()

    LaunchedEffect(Unit) { viewModel.load() }

    LazyColumn(
        contentPadding = PaddingValues(horizontal = dims.space4, vertical = dims.space4),
        verticalArrangement = Arrangement.spacedBy(dims.space4),
        modifier = Modifier.fillMaxSize(),
    ) {
        item {
            DenScreenHeading(
                kicker = "The Den · Invites",
                title = "Invites",
                subtitle = "Every invite across every household, and who never came in. " +
                    "Expired reads Expired the minute it lapses. Sending and revoking live " +
                    "on the household's own Members screen.",
            )
        }

        // Chips only once a read succeeded. A count beside a filter while the
        // read is failing would be a number nobody could see behind.
        if (state.loaded) {
            item {
                AuntieChipGroup(
                    options = InviteFilter.entries.toList(),
                    selected = setOf(state.filter),
                    onSelectionChange = { next ->
                        next.firstOrNull()?.let { viewModel.setFilter(it) }
                    },
                    label = { it.label },
                    singleSelect = true,
                    monoSuffix = { state.countFor(it).toString() },
                )
            }
        }

        when {
            // Never an empty state during a failure: "nobody has been
            // invited" and "we could not find out" are opposite facts.
            state.error != null -> item {
                EmptyHint(state.error!!, error = true)
                Spacer(Modifier.height(dims.space2))
                GhostButton(label = "Retry", onClick = { viewModel.load() })
            }
            state.loading && !state.loaded -> item { EmptyHint("Loading invites…") }
            state.loaded && state.all.isEmpty() -> item {
                EmptyHint("No invites have been sent from any household yet.")
            }
            state.visible.isEmpty() -> item {
                EmptyHint("No invites match this filter. Every invite is still here under All.")
            }
            else -> state.sections.filter { it.rows.isNotEmpty() }.forEach { section ->
                item(key = section.heading) {
                    InviteSectionBlock(section = section, onOpenHousehold = onOpenHousehold)
                }
            }
        }
    }
}

/**
 * The mock's `.sec`: a serif heading with the mono status note beside it, then
 * the rows 10dp apart. The note is its own Text, never part of the heading, so
 * the section's accessible name stays the one word.
 */
@Composable
private fun InviteSectionBlock(
    section: InviteSection,
    onOpenHousehold: (kinfolkId: String, householdName: String) -> Unit,
) {
    val c = AuntieTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(9.dp),
            modifier = Modifier.padding(bottom = 1.dp),
        ) {
            Text(
                text = section.heading,
                style = AuntieTheme.typography.headlineSmall.copy(fontSize = 19.sp),
                color = c.textPrimary,
                modifier = Modifier.semantics { heading() },
            )
            Text(
                text = "${section.statusNote} · ${section.rows.size}",
                style = AuntieTheme.typography.mono.copy(fontSize = 11.sp),
                color = c.textDim,
                modifier = Modifier.padding(bottom = 2.dp),
            )
        }
        section.rows.forEach { row ->
            AdminInviteRow(row = row, onOpen = onOpenHousehold)
        }
    }
}

/**
 * The mock's `.iv`: a 4dp tone stripe, a 42dp framed circle, the address in
 * bold, the provenance line, the pills. The whole row opens the household.
 *
 * The mock draws a profile photo in the circle. An invite is an address with
 * no account yet, so there is no photo to draw; the Den avatar's own fallback,
 * a letter on the seeded gradient, stands in. Never emoji.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AdminInviteRow(
    row: MembersRepository.AdminInvite,
    onOpen: (kinfolkId: String, householdName: String) -> Unit,
) {
    val c = AuntieTheme.colors
    val invite = row.invite
    val tone = invitePillTone(invite.effectiveStatus)
    val label = invite.secondaryLabel?.trim().orEmpty()
    // Not tappable at all when the row carries no household id: a tap that
    // opens "nothing" is worse than a row that plainly cannot be opened, and
    // the row itself is still shown because it is evidence.
    val openable = row.tribeId.isNotBlank()

    GlassSurface(
        cornerRadius = 18.dp,
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .then(
                if (openable) Modifier.clickable { onOpen(row.tribeId, row.householdName) }
                else Modifier,
            ),
    ) {
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
                // The household leads the provenance line. The mock is one
                // household deep and has no such line; this is the admin-wide
                // screen's one addition, and it is the row's tap target's name.
                Text(
                    text = row.householdName,
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textPrimary,
                )
                Text(
                    text = adminInviteMetaLine(row),
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
                    )
                    AuntieStatusPill(
                        label = roleLabel(invite.proposedRole),
                        tone = AuntieStatusTone.Purple,
                        mono = true,
                    )
                    if (label.isNotEmpty()) {
                        AuntieStatusPill(label = label, tone = AuntieStatusTone.Neutral, mono = true)
                    }
                }
            }
        }
    }
}

/**
 * The mock's own pill tints, one per status: pending and email sent in orange,
 * accepted in teal, revoked in coral, expired in the muted grey. Local to this
 * screen rather than the shared [inviteStatusTone], which paints the
 * household's Members screen and is that screen's to change.
 */
internal fun invitePillTone(status: MembersRepository.InviteStatus): AuntieStatusTone = when (status) {
    MembersRepository.InviteStatus.ACCEPTED -> AuntieStatusTone.Teal
    MembersRepository.InviteStatus.REVOKED -> AuntieStatusTone.Error
    MembersRepository.InviteStatus.EXPIRED -> AuntieStatusTone.Muted
    MembersRepository.InviteStatus.PENDING,
    MembersRepository.InviteStatus.EMAIL_SENT -> AuntieStatusTone.Orange
}

/** The mock's `.pill.role`: "Primary" or "Secondary". */
internal fun roleLabel(role: MembersRepository.MemberRole): String =
    role.name.first() + role.name.drop(1).lowercase()

/**
 * The provenance line's date words, in the mock's casing: "Sent" (or
 * "Created" when the mail never went), then the one date that matters for the
 * row's state. Accepted carries no second date because the server returns no
 * acceptance timestamp. Mirrors `inviteDateParts` on web.
 *
 * Only dates the server actually returned appear; a missing timestamp reads
 * "unknown" rather than today, because a fabricated date here is a date
 * somebody would act on.
 */
internal fun adminInviteDateParts(invite: MembersRepository.Invite): List<String> {
    val parts = mutableListOf<String>()
    if (invite.sentToInviteeAt != null) {
        parts += "Sent ${inviteDate(invite.sentToInviteeAt) ?: "unknown"}"
    } else {
        parts += "Created ${inviteDate(invite.createdAt) ?: "unknown"}"
    }
    when (invite.effectiveStatus) {
        MembersRepository.InviteStatus.REVOKED -> {
            parts += "revoked ${inviteDate(invite.revokedAt) ?: "unknown"}"
        }
        MembersRepository.InviteStatus.EXPIRED -> {
            parts += "expired ${inviteDate(invite.expiresAt) ?: "unknown"}"
        }
        MembersRepository.InviteStatus.ACCEPTED -> Unit
        MembersRepository.InviteStatus.PENDING,
        MembersRepository.InviteStatus.EMAIL_SENT -> {
            parts += "expires ${inviteDate(invite.expiresAt) ?: "unknown"}"
        }
    }
    return parts
}

/**
 * The row's provenance line: the dates, then the truncated handle. The
 * household is a separate line above it, not part of this string.
 */
internal fun adminInviteMetaLine(row: MembersRepository.AdminInvite): String =
    (adminInviteDateParts(row.invite) + "inviteId ${inviteHandle(row.invite.inviteId)}")
        .joinToString(" · ")
