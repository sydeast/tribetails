package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.viewmodel.compose.viewModel
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.X
import com.tribetails.auntieos.data.repository.MessageSuppressionRepository.Suppression
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieChipGroup
import com.tribetails.auntieos.ui.components.AuntieDialog
import com.tribetails.auntieos.ui.components.AuntieLoading
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * #1083: Settings > Notifications > Do-not-send list on Android. Every address
 * the app will not mail or text: hard bounces recorded by the smtp2go webhook
 * and opt-outs the owner entered. The web twin is `DoNotSendSection.tsx`.
 *
 * Self-loading, like the Email frame: the collection is denied to every client
 * in the rules, so the list and the clear are both callables. Clear asks first,
 * in a dialog, and the server records who cleared it.
 *
 * Clear removes a bounce, never an opt-out. A row that is only an opt-out has no
 * Clear action, and a row that is both keeps its opt-out once the bounce goes.
 */

private val FILTERS = listOf("all", "hard_bounce", "opt_out")

internal fun doNotSendFilterLabel(key: String): String = when (key) {
    "hard_bounce" -> "Hard bounces"
    "opt_out" -> "Opt-outs"
    else -> "All"
}

internal fun doNotSendReasonLabel(row: Suppression): String =
    if (row.reason == "hard_bounce") "Hard bounce" else "Opted out"

internal fun doNotSendSourceLabel(row: Suppression): String =
    if (row.source == "smtp2go") "smtp2go" else "Admin"

/** The meta line under the address: reason, an opt-out that also holds, source, when. */
internal fun doNotSendMetaLine(row: Suppression): String = listOfNotNull(
    doNotSendReasonLabel(row),
    "Also opted out".takeIf { row.reason == "hard_bounce" && row.optedOut },
    doNotSendSourceLabel(row),
    doNotSendWhenLabel(row.suppressedAtMs),
).joinToString(", ")

private val WHEN_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")

/** Local `YYYY-MM-DD HH:mm`, matching the web list. */
internal fun doNotSendWhenLabel(ms: Long): String =
    if (ms <= 0L) {
        "(no time)"
    } else {
        Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()).format(WHEN_FORMAT)
    }

@Composable
internal fun DoNotSendPanel(
    vm: DoNotSendViewModel = viewModel { DoNotSendViewModel() },
) {
    val s by vm.state.collectAsState()
    val c = AuntieTheme.colors
    val t = AuntieTheme.typography
    val dims = AuntieTheme.dims

    DenPanel(title = "Do-not-send list") {
        Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
            AuntieChipGroup(
                options = FILTERS,
                selected = setOf(s.filter),
                onSelectionChange = { next -> next.firstOrNull()?.let { vm.setFilter(it) } },
                label = { doNotSendFilterLabel(it) },
                singleSelect = true,
            )

            s.note?.let { msg ->
                AuntieBanner(tone = AuntieBannerTone.Success, title = "Cleared", icon = Lucide.X) {
                    Text(msg, style = t.bodySmall, color = c.textDim)
                }
            }
            s.error?.let { msg ->
                AuntieBanner(tone = AuntieBannerTone.Error, title = "That did not work", icon = Lucide.X) {
                    Text(msg, style = t.bodySmall, color = c.textDim)
                }
            }

            when (val load = s.load) {
                DoNotSendViewModel.Load.Loading ->
                    AuntieLoading(text = "Loading the do-not-send list…", onSync = { vm.load() })

                is DoNotSendViewModel.Load.Failed -> AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    title = "Do-not-send list unavailable",
                    icon = Lucide.X,
                    trailing = { GhostButton(label = "Retry", onClick = { vm.load() }) },
                    body = { Text(load.message, style = t.bodySmall, color = c.textDim) },
                )

                is DoNotSendViewModel.Load.Ready -> {
                    if (load.items.isEmpty()) {
                        Text("No addresses on the list.", style = t.bodyMedium, color = c.textDim)
                    }
                    load.items.forEach { row ->
                        Row(
                            modifier = Modifier.fillMaxWidth().testTag("doNotSend.row.${row.recipient}"),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(
                                modifier = Modifier.weight(1f),
                                verticalArrangement = Arrangement.spacedBy(dims.space1),
                            ) {
                                Text(row.recipient, style = t.bodyMedium, color = c.textPrimary)
                                Text(doNotSendMetaLine(row), style = t.bodySmall, color = c.textDim)
                            }
                            if (row.clearable) {
                                GhostButton(
                                    label = "Clear",
                                    onClick = { vm.askClear(row) },
                                    enabled = !s.clearing,
                                    modifier = Modifier.testTag("doNotSend.clear.${row.recipient}"),
                                )
                            }
                        }
                    }
                    if (load.nextCursor != null) {
                        GhostButton(
                            label = "Load more",
                            onClick = { vm.loadMore() },
                            enabled = !s.loadingMore,
                            modifier = Modifier.testTag("doNotSend.more"),
                        )
                    }
                }
            }
        }
    }

    val pending = s.pending
    AuntieDialog(
        visible = pending != null,
        title = "Clear this bounce?",
        onDismiss = { vm.cancelClear() },
        footer = {
            GhostButton(label = "Keep it", onClick = { vm.cancelClear() }, enabled = !s.clearing)
            PrimaryButton(label = "Clear address", onClick = { vm.confirmClear() }, enabled = !s.clearing, loading = s.clearing)
        },
    ) {
        if (pending != null) {
            val optOut = if (pending.optedOut) " Their opt-out stays." else ""
            Text(
                "${pending.recipient} comes off the bounce list and Auntie can mail it again.$optOut " +
                    "Your name is recorded against the change.",
                style = t.bodyMedium,
                color = c.textPrimary,
            )
        }
    }
}
