package com.tribetails.auntieos.web.screens.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.observability.rememberReportingScope
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieChipGroup
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import kotlinx.coroutines.launch

/**
 * #1102: Settings > Notifications > Do-not-send list. Every address the app
 * will not mail or text: hard bounces recorded by the smtp2go webhook and
 * opt-outs the owner entered. Twins: `DoNotSendSection.tsx` on admin web and
 * `DoNotSendPanel.kt` on Android. The state and rules live in [DoNotSendModel].
 *
 * Self-loading, like the notification gate: the collection is denied to every
 * client in the rules, so the list and the clear are both callables. Clear asks
 * first, in a dialog inside the app, and the server records who cleared it.
 */
@Composable
internal fun DoNotSendPanel() {
    val c = AuntieTheme.colors
    val t = AuntieTheme.typography
    val scope = rememberReportingScope()
    val model = remember { DoNotSendModel() }
    val s by model.state.collectAsState()
    // Reloads on first show and whenever the filter changes.
    LaunchedEffect(s.filter) { model.load() }
    DenPanel(title = "Do-not-send list") {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            AuntieChipGroup(
                options = DO_NOT_SEND_FILTERS,
                selected = setOf(s.filter),
                onSelectionChange = { next -> next.firstOrNull()?.let { model.setFilter(it) } },
                label = { doNotSendFilterLabel(it) },
                singleSelect = true,
            )
            s.note?.let { msg ->
                AuntieBanner(tone = AuntieBannerTone.Success, title = "Cleared", onDismiss = { model.dismissMessages() }) {
                    Text(msg, style = t.bodySmall, color = c.textDim)
                }
            }
            s.error?.let { msg ->
                AuntieBanner(tone = AuntieBannerTone.Error, title = "That did not work", onDismiss = { model.dismissMessages() }) {
                    Text(msg, style = t.bodySmall, color = c.textDim)
                }
            }
            when (val load = s.load) {
                DoNotSendLoad.Loading ->
                    Text("Loading the do-not-send list…", style = t.bodySmall, color = c.textDim)
                is DoNotSendLoad.Failed -> AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    title = "Do-not-send list unavailable",
                    trailing = { GhostButton(label = "Retry", onClick = { scope.launch { model.load() } }) },
                ) {
                    Text(load.message, style = t.bodySmall, color = c.textDim)
                }
                is DoNotSendLoad.Ready -> {
                    if (load.items.isEmpty()) {
                        Text("No addresses on the list.", style = t.bodyMedium, color = c.textDim)
                    }
                    load.items.forEach { row ->
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(row.recipient, style = t.bodyMedium, color = c.textPrimary)
                                Text(doNotSendMetaLine(row), style = t.bodySmall, color = c.textDim)
                            }
                            if (row.clearable) {
                                GhostButton(
                                    label = "Clear",
                                    onClick = { model.askClear(row) },
                                    enabled = !s.clearing,
                                )
                            }
                        }
                    }
                    if (load.nextCursor != null) {
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            GhostButton(
                                label = "Load more",
                                onClick = { scope.launch { model.loadMore() } },
                                enabled = !s.loadingMore,
                            )
                            if (s.loadingMore) Text("Loading more…", style = t.bodySmall, color = c.textDim)
                        }
                    }
                }
            }
        }
    }
    val pending = s.pending
    AuntieDialog(
        visible = pending != null,
        title = "Clear this bounce?",
        onDismiss = { model.cancelClear() },
        maxWidth = 480.dp,
        footer = {
            GhostButton(label = "Keep it", onClick = { model.cancelClear() }, enabled = !s.clearing)
            PrimaryButton(
                label = "Clear address",
                onClick = { scope.launch { model.confirmClear() } },
                enabled = !s.clearing,
                loading = s.clearing,
            )
        },
    ) {
        if (pending != null) {
            Text(doNotSendConfirmText(pending), style = t.bodyMedium, color = c.textPrimary)
        }
    }
}
