package com.tribetails.auntieos.ui.members

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
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
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.data.repository.inviteHandle
import com.tribetails.auntieos.ui.components.AuntieKeyValueRow
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.DenCrumb
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * ONE invite (#1339). The Android half of
 * `auntieos-admin/src/screens/InviteDetail.tsx`; the two move together.
 *
 * ACTIONS. The list offers one, the household; Revoke and the rest live on
 * [HouseholdMembersScreen] (the 2026-08-04 invite ruling). This screen offers
 * that same one, as a button, and does not grow a second Revoke.
 *
 * THE INVITE ID IS A BEARER TOKEN: only [inviteHandle]'s truncated form shows.
 */
@Composable
fun InviteDetailScreen(
    inviteId: String,
    onBack: () -> Unit,
    onOpenHousehold: (kinfolkId: String, householdName: String) -> Unit,
    viewModel: InviteDetailViewModel = remember(inviteId) { InviteDetailViewModel(inviteId) },
) {
    AuntieScreenScaffold(title = "Invite", onBack = onBack) {
        InviteDetailBody(viewModel = viewModel, onInvites = onBack, onOpenHousehold = onOpenHousehold)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun InviteDetailBody(
    viewModel: InviteDetailViewModel,
    onInvites: () -> Unit,
    onOpenHousehold: (kinfolkId: String, householdName: String) -> Unit,
) {
    val dims = AuntieTheme.dims
    val state by viewModel.uiState.collectAsState()

    LaunchedEffect(Unit) { viewModel.load() }

    val detail = state.invite
    val title = detail?.admin?.invite?.invitedEmail ?: "Invite"

    LazyColumn(
        contentPadding = PaddingValues(horizontal = dims.space4, vertical = dims.space4),
        verticalArrangement = Arrangement.spacedBy(dims.space4),
        modifier = Modifier.fillMaxSize(),
    ) {
        item {
            DenScreenHeading(
                kicker = "The Den · Invites",
                title = title,
                crumbs = listOf(DenCrumb("Invites", onInvites), DenCrumb(title)),
            )
        }

        state.error?.let { message ->
            item {
                EmptyHint(message, error = true)
                Spacer(Modifier.height(dims.space2))
                GhostButton(label = "Retry", onClick = { viewModel.load() })
            }
        }

        if (detail == null) {
            if (state.error == null) item { EmptyHint("Loading this invite…") }
            return@LazyColumn
        }

        val invite = detail.admin.invite
        item {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                AuntieStatusPill(
                    label = inviteStatusLabel(invite.effectiveStatus),
                    tone = invitePillTone(invite.effectiveStatus),
                    mono = true,
                )
                AuntieStatusPill(label = roleLabel(invite.proposedRole), tone = AuntieStatusTone.Purple, mono = true)
                val label = invite.secondaryLabel?.trim().orEmpty()
                if (label.isNotEmpty()) AuntieStatusPill(label = label, tone = AuntieStatusTone.Neutral, mono = true)
            }
        }
        item {
            val openable = detail.admin.tribeId.isNotBlank()
            DenPanel(title = "Invite") {
                inviteDetailFacts(detail).forEach { (label, value) ->
                    AuntieKeyValueRow(
                        label = label,
                        value = value,
                        onValueClick = if (label == "Household" && openable) {
                            { onOpenHousehold(detail.admin.tribeId, detail.admin.householdName) }
                        } else {
                            null
                        },
                    )
                }
                AuntieKeyValueRow(
                    label = "Invite",
                    value = "inviteId ${inviteHandle(invite.inviteId)}",
                    valueMono = true,
                    showDivider = false,
                )
            }
        }
        if (detail.admin.tribeId.isNotBlank()) {
            item {
                GhostButton(
                    label = "Open ${detail.admin.householdName}'s members and invites",
                    onClick = { onOpenHousehold(detail.admin.tribeId, detail.admin.householdName) },
                )
            }
        }
    }
}
