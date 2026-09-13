package com.tribetails.auntieos.ui.marketing

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import com.tribetails.auntieos.ui.communicate.SegmentKind
import com.tribetails.auntieos.ui.communicate.TagMatch
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieChipGroup
import com.tribetails.auntieos.ui.components.AuntieDialog
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.ui.components.AuntieKeyValueRow
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.AuntieTextBtn
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * Marketing blasts (scheduled campaigns), AuntieOS Android.
 *
 * Parity with the React admin's `screens/MarketingBlasts.tsx`, which is
 * mandatory in this project: mobile web is the field fallback, and both clients
 * have to offer the same thing. Same four callables, same three audience modes,
 * same four-way reach breakdown, same refusal to draw a number the backend does
 * not have (no "sending" progress bar, no open rate: a blast is promoted by a
 * 5-minute cron, and nothing here records an email open).
 *
 * The message copy is not composed here. A blast names a catalog key and the
 * pipeline renders the operator's own template for it; the merge fields are the
 * context that template is rendered against.
 *
 * Every decision lives in `MarketingBlast.kt` and the ViewModel, so this file is
 * layout.
 */
@Composable
fun MarketingBlastsScreen(viewModel: MarketingBlastsViewModel) {
    val state by viewModel.uiState.collectAsState()
    val dims = AuntieTheme.dims
    val c = AuntieTheme.colors
    val blocker = state.blocker(System.currentTimeMillis())

    var datePickerOpen by remember { mutableStateOf(false) }

    if (datePickerOpen) {
        val initial = runCatching { LocalDate.parse(state.sendDate) }.getOrNull() ?: LocalDate.now()
        val pickerState = rememberDatePickerState(
            initialSelectedDateMillis = initial.atStartOfDay(ZoneId.of("UTC")).toInstant().toEpochMilli(),
        )
        DatePickerDialog(
            onDismissRequest = { datePickerOpen = false },
            confirmButton = {
                AuntieTextBtn(onClick = {
                    pickerState.selectedDateMillis?.let { ms ->
                        // Read back in UTC, the zone it was seeded in, so the
                        // picker's own day is the day that lands in the field.
                        // The wall-clock resolution to an instant happens later,
                        // in fireAtMsFrom, in the device's zone.
                        viewModel.setSendDate(
                            Instant.ofEpochMilli(ms).atZone(ZoneId.of("UTC")).toLocalDate().toString(),
                        )
                    }
                    datePickerOpen = false
                }) { Text("OK") }
            },
            dismissButton = { AuntieTextBtn(onClick = { datePickerOpen = false }) { Text("Cancel") } },
        ) { DatePicker(state = pickerState) }
    }

    if (state.confirmOpen) {
        AuntieDialog(
            visible = true,
            title = "Schedule this blast",
            onDismiss = viewModel::closeConfirm,
            footer = {
                GhostButton(label = "Back", onClick = viewModel::closeConfirm, enabled = !state.scheduling)
                PrimaryButton(
                    label = if (state.scheduling) "Scheduling..." else "Schedule it",
                    onClick = { viewModel.schedule() },
                    enabled = !state.scheduling,
                )
            },
        ) {
            Text(
                text = confirmLine(state),
                style = AuntieTheme.typography.bodyMedium,
                color = c.textPrimary,
            )
            state.reach?.let { reach ->
                Text(
                    text = "${reach.reachable} of ${reach.matched} will receive it.",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }
        }
    }

    AuntieScreenScaffold(title = "Marketing blasts", imePaddingEnabled = true) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = dims.space4, vertical = dims.space4),
            verticalArrangement = Arrangement.spacedBy(dims.space5),
        ) {
            DenScreenHeading(
                kicker = "The Den",
                title = "Marketing",
                accentTail = "blasts",
                subtitle = "A blast is scheduled. Communicate's broadcast sends immediately.",
            )

            state.notice?.let { notice ->
                AuntieBanner(tone = AuntieBannerTone.Success, dismissible = true, onDismiss = viewModel::clearNotice) {
                    Text(notice, style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                }
            }
            state.scheduleError?.let { err ->
                AuntieBanner(tone = AuntieBannerTone.Error, title = "Schedule failed") {
                    Text(err, style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                }
            }

            // ── compose ──────────────────────────────────────────────────────
            DenPanel(
                title = "Schedule a blast",
                subtitle = "The copy comes from your template for this campaign key, authored in Template Bank. " +
                    "The merge fields below fill its tokens.",
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(dims.space4)) {
                    AuntieFieldLabel(text = "Campaign")
                    AuntieChipGroup(
                        options = MarketingKey.entries.toList(),
                        selected = setOf(state.campaignKey),
                        onSelectionChange = { next -> next.firstOrNull()?.let(viewModel::setCampaignKey) },
                        label = { it.label },
                        monoSuffix = { it.wire },
                        singleSelect = true,
                    )

                    AuntieField(
                        value = state.title,
                        onValueChange = viewModel::setTitle,
                        label = "Name this campaign",
                        placeholder = "June newsletter",
                        modifier = Modifier.fillMaxWidth(),
                    )

                    AuntieFieldLabel(text = "Audience")
                    AuntieChipGroup(
                        options = AudienceMode.entries.toList(),
                        selected = setOf(state.mode),
                        onSelectionChange = { next -> next.firstOrNull()?.let(viewModel::setMode) },
                        label = { audienceModeLabel(it) },
                        singleSelect = true,
                    )

                    state.segmentsError?.let { err ->
                        AuntieBanner(tone = AuntieBannerTone.Warning) {
                            Text(err, style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                        }
                    }

                    when (state.mode) {
                        AudienceMode.Criteria -> {
                            AuntieChipGroup(
                                options = SegmentKind.entries.toList(),
                                selected = setOf(state.criteria.kind),
                                onSelectionChange = { next -> next.firstOrNull()?.let(viewModel::setCriteriaKind) },
                                label = { it.label },
                                singleSelect = true,
                            )
                            when (state.criteria.kind) {
                                SegmentKind.All -> Unit
                                SegmentKind.Status -> AuntieField(
                                    value = state.statusesText,
                                    onValueChange = viewModel::setStatusesText,
                                    label = "Statuses (comma-separated)",
                                    placeholder = "active, prospect",
                                    modifier = Modifier.fillMaxWidth(),
                                )
                                SegmentKind.Tags -> {
                                    AuntieField(
                                        value = state.tagsText,
                                        onValueChange = viewModel::setTagsText,
                                        label = "Tags (comma-separated)",
                                        placeholder = "vip, newsletter",
                                        modifier = Modifier.fillMaxWidth(),
                                    )
                                    AuntieChipGroup(
                                        options = TagMatch.entries.toList(),
                                        selected = setOf(state.criteria.tagMatch),
                                        onSelectionChange = { next -> next.firstOrNull()?.let(viewModel::setTagMatch) },
                                        label = { it.label },
                                        singleSelect = true,
                                    )
                                }
                            }
                        }

                        AudienceMode.Segment -> {
                            if (state.segments.isEmpty()) {
                                EmptyHint("No saved segments yet. Build one on Communicate.")
                            } else {
                                AuntieChipGroup(
                                    options = state.segments.map { it.id },
                                    selected = setOfNotNull(state.selectedSegmentId),
                                    onSelectionChange = { next -> viewModel.setSelectedSegment(next.firstOrNull()) },
                                    label = { id -> state.segments.first { it.id == id }.name },
                                    monoSuffix = { id -> state.segments.first { it.id == id }.description },
                                    singleSelect = true,
                                )
                            }
                        }

                        AudienceMode.Uids -> {
                            AuntieField(
                                value = state.uidsText,
                                onValueChange = viewModel::setUidsText,
                                label = "Account ids",
                                placeholder = "One per line, or comma-separated",
                                singleLine = false,
                                minLines = 3,
                                modifier = Modifier.fillMaxWidth(),
                            )
                            val n = state.explicitUids.size
                            Text(
                                text = "$n ${if (n == 1) "account" else "accounts"}",
                                style = AuntieTheme.typography.bodySmall,
                                color = c.textDim,
                            )
                        }
                    }

                    AuntieFieldLabel(text = "Merge fields")
                    state.mergeFields.forEachIndexed { i, row ->
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(dims.space3),
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            AuntieField(
                                value = row.key,
                                onValueChange = { viewModel.setMergeFieldKey(i, it) },
                                placeholder = "token",
                                modifier = Modifier
                                    .weight(1f)
                                    .semantics { contentDescription = "Merge field ${i + 1} name" },
                            )
                            AuntieField(
                                value = row.value,
                                onValueChange = { viewModel.setMergeFieldValue(i, it) },
                                placeholder = "value",
                                modifier = Modifier
                                    .weight(1.4f)
                                    .semantics { contentDescription = "Merge field ${i + 1} value" },
                            )
                        }
                    }
                    GhostButton(label = "Add a field", onClick = viewModel::addMergeField)

                    AuntieFieldLabel(text = "Send time")
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(dims.space3),
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        AuntieField(
                            value = state.sendDate,
                            onValueChange = viewModel::setSendDate,
                            label = "Date",
                            placeholder = "2026-06-03",
                            readOnly = true,
                            modifier = Modifier.weight(1f),
                        )
                        GhostButton(label = "Pick a date", onClick = { datePickerOpen = true })
                    }
                    AuntieField(
                        value = state.sendTime,
                        onValueChange = viewModel::setSendTime,
                        label = "Time",
                        placeholder = "09:00",
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    state.fireAtMs?.let { ms ->
                        Text(
                            text = "Fires ${fireLabel(ms)}, your local time.",
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textDim,
                        )
                    }

                    Row(horizontalArrangement = Arrangement.spacedBy(dims.space3)) {
                        GhostButton(
                            label = if (state.previewing) "Checking..." else "Check who this reaches",
                            onClick = viewModel::previewAudience,
                            enabled = state.audience != null && !state.previewing && !state.scheduling,
                        )
                        PrimaryButton(
                            label = "Schedule blast",
                            onClick = viewModel::openConfirm,
                            enabled = blocker == null && !state.scheduling && !state.previewing,
                        )
                    }
                    blocker?.let {
                        Text(it, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }
                }
            }

            // ── reach ────────────────────────────────────────────────────────
            DenPanel(title = "Who this reaches") {
                Column {
                    val reach = state.reach
                    when {
                        state.previewError != null ->
                            EmptyHint(state.previewError ?: "", error = true)
                        reach == null ->
                            EmptyHint("Not checked yet for this audience.")
                        else -> {
                            AuntieKeyValueRow(label = "Matched", value = reach.matched.toString(), valueMono = true)
                            AuntieKeyValueRow(
                                label = "No linked account",
                                value = reach.noLinkedAccount.toString(),
                                valueMono = true,
                            )
                            AuntieKeyValueRow(
                                label = "Opted out or gated",
                                value = reach.suppressedByPrefs.toString(),
                                valueMono = true,
                            )
                            AuntieKeyValueRow(
                                label = "Will receive it",
                                value = reach.reachable.toString(),
                                valueMono = true,
                                showDivider = false,
                            )
                        }
                    }
                }
            }

            // ── campaigns ────────────────────────────────────────────────────
            DenPanel(title = "Campaigns") {
                Column(verticalArrangement = Arrangement.spacedBy(dims.space3)) {
                    val blasts = state.blasts
                    when {
                        state.blastsError != null -> EmptyHint(state.blastsError ?: "", error = true)
                        blasts == null -> EmptyHint("Loading campaigns...")
                        else -> {
                            // #823. The mock's third group, and it is the one
                            // that had nowhere to be: a campaign whose fan-out
                            // is still walking its roster is neither scheduled
                            // nor sent, and filing it under either put a Cancel
                            // button beside something half-delivered or a Sent
                            // pill on something still going.
                            if (state.sending.isNotEmpty()) {
                                AuntieFieldLabel(text = "Sending")
                                state.sending.forEach { blast ->
                                    BlastRow(
                                        blast = blast,
                                        cancelling = state.cancellingId == blast.id,
                                        // Stoppable MID fan-out: the un-queued
                                        // remainder is real. A campaign already
                                        // stopping has nothing left to offer, so
                                        // it gets no button rather than a dead one.
                                        cancelEnabled = state.cancellingId == null &&
                                            blast.status != BlastStatus.Cancelling,
                                        onCancel = { viewModel.cancel(blast.id) },
                                    )
                                }
                                // The manual re-read PR #819's ruling asks for.
                                // No poll: the fan-out is on the server, the
                                // sweep runs once a minute, and the count moves
                                // about once every twenty-five seconds.
                                SendingSyncOffer(
                                    attempt = state.refreshes,
                                    onSync = { viewModel.refreshBlasts() },
                                )
                            }

                            AuntieFieldLabel(text = "Scheduled")
                            if (state.scheduled.isEmpty()) {
                                EmptyHint("Nothing scheduled.")
                            } else {
                                state.scheduled.forEach { blast ->
                                    BlastRow(
                                        blast = blast,
                                        cancelling = state.cancellingId == blast.id,
                                        cancelEnabled = state.cancellingId == null,
                                        onCancel = { viewModel.cancel(blast.id) },
                                    )
                                }
                            }

                            AuntieFieldLabel(text = "Sent and cancelled")
                            if (state.history.isEmpty()) {
                                EmptyHint("Nothing sent yet.")
                            } else {
                                state.history.forEach { blast ->
                                    BlastRow(blast = blast, cancelling = false, cancelEnabled = false, onCancel = {})
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/**
 * The offer under a campaign list with something still queueing (#823).
 *
 * Borrows the wait vocabulary `ui/components/SlowWait.kt` built for the
 * 2026-09-12 ruling rather than inventing a second progress language: the shape
 * is the same one, say what is being waited on, offer a manual sync, and the
 * copy changes on a second press because a tap with no visible consequence reads
 * as a dead button. Safe to press repeatedly because it points at a READ.
 */
@Composable
private fun SendingSyncOffer(attempt: Int, onSync: () -> Unit) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(dims.space2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = if (attempt > 0) "Asked again. Still queueing." else "This carries on in the background.",
            style = AuntieTheme.typography.bodySmall,
            color = c.textDim,
            modifier = Modifier.weight(1f),
        )
        GhostButton(label = if (attempt > 0) "Ask again" else "Check again", onClick = onSync)
    }
}

/** One campaign row. Cancel appears on a scheduled blast and on one still being queued. */
@Composable
private fun BlastRow(
    blast: MarketingBlastRow,
    cancelling: Boolean,
    cancelEnabled: Boolean,
    onCancel: () -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(dims.space3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(blast.displayName, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
            Text(
                text = blastMeta(blast),
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
            // The mock's `.sendprog` bar, drawn only where the row can back it.
            // `--orange` in the mock, `c.primary` here: the same token the
            // Sending pill beside it resolves to, rather than picked again.
            if (blast.status == BlastStatus.Sending) {
                LinearProgressIndicator(
                    progress = { blast.progress },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(top = dims.space1)
                        .height(4.dp)
                        .clip(AuntieTheme.shapes.pill),
                    color = c.primary,
                    trackColor = c.border,
                    gapSize = 0.dp,
                    drawStopIndicator = {},
                )
            }
        }
        AuntieStatusPill(label = blast.status.label, tone = statusTone(blast.status), compact = true)
        if (blast.status == BlastStatus.Scheduled || blast.status == BlastStatus.Sending) {
            GhostButton(
                label = cancelLabel(blast.status, cancelling),
                onClick = onCancel,
                enabled = cancelEnabled,
            )
        }
    }
}

/** The second line of a campaign row. Pure; unit-tested. */
internal fun blastMeta(blast: MarketingBlastRow): String {
    val head = "${blast.key} ${blast.audienceDescription} ${fireLabel(blast.fireAtMs)}".trim()
    return when (blast.status) {
        BlastStatus.Scheduled -> head
        // #823: the mock's "256 of 410 dispatched". A stalled fan-out says it
        // stopped moving rather than being dressed up as a slow one.
        BlastStatus.Sending, BlastStatus.Cancelling ->
            "$head, " + sendingLabel(
                blast.queued,
                blast.audienceSize,
                blast.fanoutState == BlastFanoutState.Stalled,
            )
        // A campaign whose fan-out never armed queued nothing, and "0 sent, 0
        // suppressed" would read as a send that reached nobody rather than as
        // one that never started.
        BlastStatus.Failed -> "$head, never queued"
        else -> "$head, ${blast.dispatched} sent, ${blast.suppressed} suppressed"
    }
}

/** Cancel says what it would actually do, which differs mid fan-out. Pure. */
internal fun cancelLabel(status: BlastStatus, busy: Boolean): String = when {
    status == BlastStatus.Sending && busy -> "Stopping..."
    status == BlastStatus.Sending -> "Stop sending"
    busy -> "Cancelling..."
    else -> "Cancel"
}

internal fun statusTone(status: BlastStatus): AuntieStatusTone = when (status) {
    BlastStatus.Scheduled -> AuntieStatusTone.Teal
    // The mock's orange Sending accent, resolved through the shared tone map
    // rather than a colour written here.
    BlastStatus.Sending, BlastStatus.Cancelling -> AuntieStatusTone.Orange
    BlastStatus.Sent -> AuntieStatusTone.Purple
    BlastStatus.Failed -> AuntieStatusTone.Error
    BlastStatus.Cancelled -> AuntieStatusTone.Muted
}

internal fun audienceModeLabel(mode: AudienceMode): String = when (mode) {
    AudienceMode.Criteria -> "Build a filter"
    AudienceMode.Segment -> "A saved segment"
    AudienceMode.Uids -> "Pick accounts"
}

/** The confirm dialog's one line. Pure; unit-tested. */
internal fun confirmLine(state: MarketingBlastsUiState): String {
    val who = when (state.mode) {
        AudienceMode.Uids -> {
            val n = state.explicitUids.size
            "$n chosen ${if (n == 1) "account" else "accounts"}"
        }
        AudienceMode.Segment ->
            state.segments.firstOrNull { it.id == state.selectedSegmentId }?.description ?: "a saved segment"
        AudienceMode.Criteria -> state.criteria.kind.label
    }
    val when_ = state.fireAtMs?.let { fireLabel(it) } ?: "no time yet"
    return "${state.campaignKey.label} to $who, firing $when_."
}
