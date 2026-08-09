package com.tribetails.auntieos.ui.members

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import com.tribetails.auntieos.data.repository.MembersRepository
import com.tribetails.auntieos.data.repository.inviteDate
import com.tribetails.auntieos.data.repository.inviteHandle
import com.tribetails.auntieos.ui.components.AuntieChipGroup
import com.tribetails.auntieos.ui.components.AuntieEntityRow
import com.tribetails.auntieos.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
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
 * IT IS A READ. Per the invite ruling the admin's only invite is inviting a
 * PRIMARY to the portal, and both callables that do it are household-scoped;
 * the PRIMARY invites the secondary from MyTribe. So there is no Send here, no
 * Revoke, and no permission control — an admin-WIDE surface has no household to
 * act on. Tapping a row opens that household's own members-and-invites screen,
 * where every action already lives.
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
                kicker = "The Den",
                title = "Every household's",
                accentTail = "invites.",
                subtitle = "Who was invited, and who never came in. Sending and revoking live " +
                    "on the household's own screen.",
            )
        }

        item {
            DenPanel(
                title = "Invites",
                subtitle = "Expired is accurate to the minute here: an invite reads Expired as " +
                    "soon as it lapses.",
            ) {
                // Chips only once a read succeeded. A count beside a filter while
                // the read is failing would be a number nobody could see behind.
                if (state.loaded) {
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
                    Spacer(Modifier.height(dims.space3))
                }

                when {
                    // Never an empty state during a failure: "nobody has been
                    // invited" and "we could not find out" are opposite facts.
                    state.error != null -> {
                        EmptyHint(state.error!!, error = true)
                        Spacer(Modifier.height(dims.space2))
                        GhostButton(label = "Retry", onClick = { viewModel.load() })
                    }
                    state.loading && !state.loaded -> EmptyHint("Loading invites…")
                    state.loaded && state.all.isEmpty() ->
                        EmptyHint("No invites have been sent from any household yet.")
                    state.visible.isEmpty() -> EmptyHint(
                        "No invites match this filter. Every invite is still here under All.",
                    )
                    else -> Column(verticalArrangement = Arrangement.spacedBy(dims.space4)) {
                        state.sections.forEach { section ->
                            if (section.rows.isEmpty()) return@forEach
                            Column(verticalArrangement = Arrangement.spacedBy(dims.space2)) {
                                AuntieFieldLabel(text = "${section.heading} (${section.rows.size})")
                                section.rows.forEach { row ->
                                    AdminInviteRow(row = row, onOpen = onOpenHousehold)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun AdminInviteRow(
    row: MembersRepository.AdminInvite,
    onOpen: (kinfolkId: String, householdName: String) -> Unit,
) {
    AuntieEntityRow(
        // The household leads, because on this screen the household is what
        // tells one row from another; the address is the detail.
        title = row.householdName,
        subtitle = adminInviteMetaLine(row),
        trailing = {
            AuntieStatusPill(
                label = inviteStatusLabel(row.invite.effectiveStatus),
                tone = inviteStatusTone(row.invite.effectiveStatus),
            )
        },
        // Not offered at all when the row carries no household id: a tap that
        // opens "nothing" is worse than a row that plainly cannot be opened,
        // and the row itself is still shown because it is evidence.
        onClick = if (row.tribeId.isBlank()) {
            null
        } else {
            { onOpen(row.tribeId, row.householdName) }
        },
    )
}

/**
 * The row's one-line detail: address, dates, truncated handle.
 *
 * Only dates the server actually returned appear; a missing timestamp is
 * omitted rather than filled with today. Mirrors [inviteMetaLine], with the
 * invited address prepended, because up here the title is the household.
 */
internal fun adminInviteMetaLine(row: MembersRepository.AdminInvite): String {
    val invite = row.invite
    val parts = mutableListOf<String>()
    if (invite.invitedEmail.isNotBlank()) parts += invite.invitedEmail
    val sent = inviteDate(invite.sentToInviteeAt)
    val created = inviteDate(invite.createdAt)
    when {
        sent != null -> parts += "sent $sent"
        created != null -> parts += "created $created"
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
