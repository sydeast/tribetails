package com.tribetails.auntieos.web.screens.kintales

import com.tribetails.auntieos.web.screens.bookingServiceName
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Text
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import com.tribetails.auntieos.web.observability.rememberReportingScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Archive
import com.composables.icons.lucide.ClipboardList
import com.composables.icons.lucide.Copy
import com.composables.icons.lucide.FileText
import com.composables.icons.lucide.Images
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.MailCheck
import com.composables.icons.lucide.Search
import com.composables.icons.lucide.Send
import com.composables.icons.lucide.Settings
import com.composables.icons.lucide.TriangleAlert
import com.composables.icons.lucide.UserPlus
import com.composables.icons.lucide.X
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.GeneratedDraft
import com.tribetails.auntieos.web.data.draftsAwaitingReview
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.isUntriagedOrphan
import com.tribetails.auntieos.web.observability.runCatchingCancellable
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieChipGroup
import com.tribetails.auntieos.web.ui.components.AuntieChip
import com.tribetails.auntieos.web.ui.components.AuntieChipTone
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.AuntieEmptyState
import com.tribetails.auntieos.web.ui.components.AuntieEntityRow
import com.tribetails.auntieos.web.ui.components.AuntieIconTile
import com.tribetails.auntieos.web.ui.components.AuntieSearchField
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.MultilineField
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.ui.components.StatusToast
import com.tribetails.auntieos.web.ui.components.ToastKind
import kotlinx.coroutines.launch

private enum class Bucket(val label: String) {
    Drafts ("Drafts"),
    Sent   ("Sent"),
    Failed ("Needs another look");
}

/**
 * Per-screen overlay state for the triage flow. Only one modal up at a time;
 * `null` means no overlay is showing.
 */
private sealed class TriageDialogState {
    data class Assign(val report: KinCareReport)    : TriageDialogState()
    data class Duplicate(val report: KinCareReport) : TriageDialogState()
    data class Archive(val report: KinCareReport)   : TriageDialogState()
}

/**
 * KinTales (Den redesign).
 *
 * Mirrors ui-ideas/auntieos-kintale-logs-2026-05-27.html: a Den page heading,
 * a warning-toned "Needs triage" orphan section, then Failed / Drafts / Sent
 * buckets where each report row carries the status-icon tile, the Kinfolk name
 * (italic/dim when unnamed), a serviceType · visit-timestamp submeta line, the
 * media-count + send-channel pips, and a status pill.
 *
 * All data is the live `reportsStream()`; load/empty/error states are surfaced
 * loudly. The triage dialogs write through the audited orphan-triage callables.
 */
@Composable
fun KinTaleLogsScreen(
    onOpenReport: (sessionId: String) -> Unit = {},
    /**
     * #1563: opens one `generated_drafts` doc in Communicate, where a draft is
     * reviewed, sent or deleted. Drafts were not listed here at all before, so a
     * draft Home counted could not be found on this screen.
     */
    onOpenDraft: (GeneratedDraft) -> Unit = {},
    /**
     * #1594: the list's search and sort. App holds it above the list, because
     * opening a KinTale swaps the list out and a `remember` inside it would come
     * back empty on Back.
     */
    listFilter: KinTaleListFilter = remember { KinTaleListFilter() },
) {
    var showTemplates by remember { mutableStateOf(false) }
    if (showTemplates) {
        KinTaleTemplateEditorScreen(onClose = { showTemplates = false })
        return
    }

    val client = remember { FirestoreClient() }
    // P0-FLICKER: hoist Flow construction via remember so the same Flow survives
    // recomposition (otherwise data flickers Loading -> Data each frame).
    val state by remember { client.reportsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val kinfolkState by remember { client.kinfolkStream() }.collectAsState(initial = FirestoreResult.Loading)
    // #1563: the other half of a KinTale. A KinTale in draft state is a
    // `generated_drafts` doc (ruling D-2026-08-04); only the unsent ones are listed.
    val draftsState by remember { client.generatedDraftsStream() }.collectAsState(initial = FirestoreResult.Loading)
    // #1592: rows name their service from the KinCare catalog, never `visit_60`.
    val kinCareSettings by remember { client.businessSettingsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val kinCareRates = (kinCareSettings as? FirestoreResult.Data)?.value?.serviceRates.orEmpty()
    val unsentDrafts = draftsAwaitingReview((draftsState as? FirestoreResult.Data)?.value.orEmpty())

    val scope = rememberReportingScope()
    var dialog by remember { mutableStateOf<TriageDialogState?>(null) }
    var toastMessage by remember { mutableStateOf<String?>(null) }
    var toastKind by remember { mutableStateOf(ToastKind.Success) }
    var pendingReportId by remember { mutableStateOf<String?>(null) }

    var search by listFilter::search
    var sortMode by listFilter::sort

    ScreenScaffold {
        DenScreenHeading(
            kicker     = "The Den · KinTales",
            title      = "KinTales",
            subtitle   = "Every recap that goes home to a Kinfolk after care",
            trailing   = {
                GhostButton(
                    label   = "Edit templates",
                    onClick = { showTemplates = true },
                    leading = { Icon(Lucide.Settings, contentDescription = null, modifier = Modifier.size(13.dp)) },
                )
            },
        )

        Spacer(Modifier.height(20.dp))

        // List-level search. There is no server-side report-search callable, so this is a
        // CLIENT-SIDE filter over the loaded KinTales only. Disclose that limitation (fail
        // loud) so the operator is not misled into thinking it searches the whole archive.
        AuntieSearchField(
            value = search,
            onValueChange = { search = it },
            placeholder = "Search KinTales by Kinfolk, headline or body...",
            leadingIcon = Lucide.Search,
            onClear = { search = "" },
            modifier = Modifier.fillMaxWidth(),
        )
        Spacer(Modifier.height(6.dp))
        Text(
            text  = "Filters the KinTales loaded here, not the full archive.",
            style = AuntieTheme.typography.labelSmall,
            color = AuntieTheme.colors.textFaint,
        )
        Spacer(Modifier.height(12.dp))
        // KT1: operator-chosen ordering so the Sent bucket can be organized, not just
        // an ever-growing newest-first scroll. Applied before bucketing below.
        Text("Sort", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textDim)
        Spacer(Modifier.height(6.dp))
        AuntieChipGroup(
            options           = ReportSort.entries.toList(),
            selected          = setOf(sortMode),
            onSelectionChange = { next -> next.firstOrNull()?.let { sortMode = it } },
            label             = { it.label },
            singleSelect      = true,
        )
        Spacer(Modifier.height(16.dp))

        StatusToast(
            visible = toastMessage != null,
            message = toastMessage.orEmpty(),
            kind    = toastKind,
            onDismiss = { toastMessage = null },
        )

        when (val s = state) {
            FirestoreResult.Loading ->
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    repeat(4) { ShimmerCard(height = 92.dp) }
                }

            // Fail loud: a banner that does not auto-dismiss when the live stream errors.
            is FirestoreResult.Error -> AuntieBanner(
                tone  = AuntieBannerTone.Error,
                title = "Couldn't load KinTales",
                icon  = Lucide.TriangleAlert,
            ) {
                Text(
                    text  = s.message,
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim,
                )
            }

            is FirestoreResult.Data -> {
                if (s.value.isEmpty() && unsentDrafts.isEmpty()) {
                    EmptyState()
                } else {
                    val (orphans, nonOrphans) = partitionForDisplay(s.value)

                    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
                        if (orphans.isNotEmpty()) {
                            NeedsTriageSection(
                                orphans         = orphans,
                                onAssign        = { dialog = TriageDialogState.Assign(it) },
                                onDuplicate     = { dialog = TriageDialogState.Duplicate(it) },
                                onArchive       = { dialog = TriageDialogState.Archive(it) },
                                pendingReportId = pendingReportId,
                            )
                        }

                        val grouped = sortReports(nonOrphans.filter { matchesSearch(it, search) }, sortMode)
                            .groupBy { bucketFor(it) }

                        val drafts = unsentDrafts.filter { matchesDraftSearch(it, search) }
                        listOf(Bucket.Failed, Bucket.Drafts, Bucket.Sent).forEach { bucket ->
                            val items = grouped[bucket].orEmpty()
                            val bucketDrafts = if (bucket == Bucket.Drafts) drafts else emptyList()
                            if (items.isNotEmpty() || bucketDrafts.isNotEmpty()) {
                                BucketGroup(
                                    bucket       = bucket,
                                    reports      = items,
                                    drafts       = bucketDrafts,
                                    serviceRates = kinCareRates,
                                    onOpenReport = onOpenReport,
                                    onOpenDraft  = onOpenDraft,
                                )
                            }
                        }

                        // A failed drafts read never passes for "no drafts".
                        (draftsState as? FirestoreResult.Error)?.let { err ->
                            Text(
                                text  = "Drafts could not be loaded (${err.message}), so the Drafts count is missing them.",
                                style = AuntieTheme.typography.bodySmall,
                                color = AuntieTheme.colors.error,
                            )
                        }
                    }
                }
            }
        }
    }

    // Overlay dialogs route through AuntieDialog (the Den modal scaffold). Each
    // floats over the page on a Popup, so it draws above the scaffold without
    // needing a dedicated scaffold slot.
    when (val d = dialog) {
        is TriageDialogState.Assign -> AssignKinfolkDialog(
            report = d.report,
            kinfolkState = kinfolkState,
            onDismiss = { dialog = null },
            onConfirm = { k ->
                dialog = null
                pendingReportId = d.report._id
                scope.launch {
                    val r = client.assignKinfolkToOrphanReport(d.report._id, k._id, k.displayName)
                    pendingReportId = null
                    when (r) {
                        is WriteResult.Ok -> {
                            toastKind = ToastKind.Success
                            toastMessage = "Linked KinTale to ${k.displayName}"
                        }
                        is WriteResult.Err -> {
                            toastKind = ToastKind.Error
                            toastMessage = "Couldn't link KinTale: ${r.message}"
                        }
                    }
                }
            },
        )

        is TriageDialogState.Duplicate -> MarkDuplicateDialog(
            report = d.report,
            allReports = (state as? FirestoreResult.Data)?.value.orEmpty(),
            onDismiss = { dialog = null },
            onConfirm = { masterId ->
                dialog = null
                pendingReportId = d.report._id
                scope.launch {
                    val r = client.markOrphanReportAsDuplicate(d.report._id, masterId)
                    pendingReportId = null
                    when (r) {
                        is WriteResult.Ok -> {
                            toastKind = ToastKind.Success
                            toastMessage = "Marked KinTale as duplicate"
                        }
                        is WriteResult.Err -> {
                            toastKind = ToastKind.Error
                            toastMessage = "Couldn't mark duplicate: ${r.message}"
                        }
                    }
                }
            },
        )

        is TriageDialogState.Archive -> ArchiveBadDataDialog(
            report = d.report,
            onDismiss = { dialog = null },
            onConfirm = { reason ->
                dialog = null
                pendingReportId = d.report._id
                scope.launch {
                    val r = client.archiveOrphanReportAsBadData(d.report._id, reason)
                    pendingReportId = null
                    when (r) {
                        is WriteResult.Ok -> {
                            toastKind = ToastKind.Success
                            toastMessage = "Archived KinTale as bad data"
                        }
                        is WriteResult.Err -> {
                            toastKind = ToastKind.Error
                            toastMessage = "Couldn't archive KinTale: ${r.message}"
                        }
                    }
                }
            },
        )

        null -> Unit
    }
}

/**
 * Splits the report list into (untriaged-orphans, everything-else-that-should-render).
 * Reports with a non-blank `triageStatus` are filtered out of both buckets entirely
 * (they're done, no longer need a UI row).
 */
internal fun partitionForDisplay(
    reports: List<KinCareReport>,
): Pair<List<KinCareReport>, List<KinCareReport>> {
    val orphans = reports.filter { it.isUntriagedOrphan() }
    val rest = reports.filter { r ->
        !r.isUntriagedOrphan() && r.triageStatus.isBlank()
    }
    return orphans to rest
}

@Composable
private fun NeedsTriageSection(
    orphans: List<KinCareReport>,
    onAssign: (KinCareReport) -> Unit,
    onDuplicate: (KinCareReport) -> Unit,
    onArchive: (KinCareReport) -> Unit,
    pendingReportId: String?,
) {
    DenPanel(
        title    = "Needs triage",
        subtitle = "Pre-cutover visit logs migrated without a Kinfolk link. Assign, mark duplicate, or archive each.",
        trailing = {
            AuntieChip(
                label = "${orphans.size} orphan${if (orphans.size == 1) "" else "s"}",
                tone  = AuntieChipTone.Orange,
                mono  = true,
            )
        },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            // Warning banner: surfaces the migration orphans that still need an
            // admin decision. Copy is verbatim from the prior source.
            AuntieBanner(
                tone  = AuntieBannerTone.Warning,
                icon  = Lucide.TriangleAlert,
            ) {
                Text(
                    text  = "These rows have no Kinfolk and no triage decision yet. Resolve each before it counts as a real KinTale.",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim,
                )
            }

            orphans.forEach { report ->
                OrphanRow(
                    report = report,
                    pending = pendingReportId == report._id,
                    onAssign = { onAssign(report) },
                    onDuplicate = { onDuplicate(report) },
                    onArchive = { onArchive(report) },
                )
            }
        }
    }
}

@Composable
private fun OrphanRow(
    report: KinCareReport,
    pending: Boolean,
    onAssign: () -> Unit,
    onDuplicate: () -> Unit,
    onArchive: () -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(c.surfaceGlass)
            .border(dims.borderHairline, c.borderSoft, RoundedCornerShape(10.dp))
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text  = reportWhen(report, currentYear()),
                style = AuntieTheme.typography.mono.copy(fontWeight = FontWeight.SemiBold),
                color = c.textDim,
            )
            Text("·", style = AuntieTheme.typography.bodySmall, color = c.textFaint)
            Text(
                text  = prettySentVia(report.sentVia),
                style = AuntieTheme.typography.mono,
                color = c.textDim,
            )
        }
        Text(
            text  = bodyPreview(report.bodyCopy),
            style = AuntieTheme.typography.bodyMedium,
            color = c.textPrimary,
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            GhostButton(
                label   = if (pending) "Working..." else "Assign Kinfolk",
                onClick = onAssign,
                enabled = !pending,
                leading = { Icon(Lucide.UserPlus, contentDescription = null, modifier = Modifier.size(13.dp)) },
                modifier = Modifier.weight(1f),
            )
            GhostButton(
                label   = "Mark Duplicate",
                onClick = onDuplicate,
                enabled = !pending,
                leading = { Icon(Lucide.Copy, contentDescription = null, modifier = Modifier.size(13.dp)) },
                modifier = Modifier.weight(1f),
            )
            GhostButton(
                label   = "Archive (Bad Data)",
                onClick = onArchive,
                enabled = !pending,
                leading = { Icon(Lucide.Archive, contentDescription = null, modifier = Modifier.size(13.dp)) },
                modifier = Modifier.weight(1f),
            )
        }
    }
}

/**
 * Trim the report body to roughly 80 chars for the list-row preview. We collapse
 * whitespace so multi-line drafts don't blow out the row height.
 */
internal fun bodyPreview(body: String): String {
    val cleaned = body.replace(Regex("\\s+"), " ").trim()
    if (cleaned.isBlank()) return "(empty body)"
    return if (cleaned.length <= 80) cleaned else cleaned.take(80) + "…"
}

@Composable
private fun AssignKinfolkDialog(
    report: KinCareReport,
    kinfolkState: FirestoreResult<List<Kinfolk>>,
    onDismiss: () -> Unit,
    onConfirm: (Kinfolk) -> Unit,
) {
    val c = AuntieTheme.colors
    var query by remember { mutableStateOf("") }
    var selected by remember { mutableStateOf<Kinfolk?>(null) }

    AuntieDialog(
        visible = true,
        title = TRIAGE_ASSIGN_TITLE,
        onDismiss = onDismiss,
        maxWidth = 520.dp,
        closeIcon = Lucide.X,
        leadingIcon = { AuntieIconTile(icon = Lucide.UserPlus, tone = AuntieStatusTone.Orange, size = 36.dp) },
        footer = {
            GhostButton(label = "Cancel", onClick = onDismiss)
            PrimaryButton(
                label = "Assign",
                enabled = selected != null,
                onClick = { selected?.let(onConfirm) },
            )
        },
    ) {
        BottomBorderField(
            value = query,
            onValueChange = { query = it },
            label = "Search",
            placeholder = "name or email",
            modifier = Modifier.fillMaxWidth(),
        )

        when (kinfolkState) {
            FirestoreResult.Loading -> Text("Loading kinfolk...", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            // Fail loud inside the dialog: an error banner that does not auto-dismiss.
            is FirestoreResult.Error -> AuntieBanner(
                tone  = AuntieBannerTone.Error,
                title = "Couldn't load kinfolk",
                icon  = Lucide.TriangleAlert,
            ) {
                Text(kinfolkState.message, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
            is FirestoreResult.Data -> {
                val q = query.lowercase().trim()
                val filtered = kinfolkState.value
                    .filter { it.status != "archived" }
                    .filter {
                        q.isBlank() ||
                            it.displayName.lowercase().contains(q) ||
                            it.email.lowercase().contains(q)
                    }
                    .sortedBy { it.displayName.lowercase() }

                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(max = 320.dp)
                        .verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    if (filtered.isEmpty()) {
                        Text(
                            text = "No matching kinfolk.",
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textDim,
                        )
                    } else {
                        filtered.forEach { k ->
                            PickerRow(
                                label = k.displayName,
                                sublabel = k.email.ifBlank { k.phoneNumber },
                                selected = selected?._id == k._id,
                                onClick = { selected = k },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun MarkDuplicateDialog(
    report: KinCareReport,
    allReports: List<KinCareReport>,
    onDismiss: () -> Unit,
    onConfirm: (masterReportId: String) -> Unit,
) {
    val c = AuntieTheme.colors
    var query by remember { mutableStateOf("") }
    var selected by remember { mutableStateOf<KinCareReport?>(null) }

    // Master candidates: everything that isn't this report itself and isn't
    // itself an untriaged orphan. Triaged reports are fine to point at if the
    // admin wants. They have valid kinfolkId.
    val candidates = remember(allReports, report._id) {
        allReports
            .filter { it._id != report._id && !it.isUntriagedOrphan() }
            .sortedWith(kinTaleDateComparator(true, ::sortMillis))
    }

    val q = query.lowercase().trim()
    val filtered = candidates.filter { r ->
        q.isBlank() ||
            r._id.lowercase().contains(q) ||
            r.kinfolkName.lowercase().contains(q) ||
            r.bodyCopy.lowercase().contains(q)
    }

    AuntieDialog(
        visible = true,
        title = TRIAGE_DUPLICATE_TITLE,
        onDismiss = onDismiss,
        maxWidth = 520.dp,
        closeIcon = Lucide.X,
        hint = "Pick the existing KinTale that this orphan duplicates.",
        leadingIcon = { AuntieIconTile(icon = Lucide.Copy, tone = AuntieStatusTone.Purple, size = 36.dp) },
        footer = {
            GhostButton(label = "Cancel", onClick = onDismiss)
            PrimaryButton(
                label = "Mark duplicate",
                enabled = selected != null,
                onClick = { selected?.let { onConfirm(it._id) } },
            )
        },
    ) {
        BottomBorderField(
            value = query,
            onValueChange = { query = it },
            label = "Search",
            placeholder = "kinfolk name or body text",
            modifier = Modifier.fillMaxWidth(),
        )

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 320.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (filtered.isEmpty()) {
                Text(
                    text = "No matching reports.",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            } else {
                filtered.forEach { r ->
                    PickerRow(
                        label = duplicateCandidateLabel(r, currentYear()),
                        sublabel = bodyPreview(r.bodyCopy),
                        selected = selected?._id == r._id,
                        onClick = { selected = r },
                    )
                }
            }
        }
    }
}

@Composable
private fun ArchiveBadDataDialog(
    report: KinCareReport,
    onDismiss: () -> Unit,
    onConfirm: (reason: String) -> Unit,
) {
    val c = AuntieTheme.colors
    var reason by remember { mutableStateOf("") }
    val trimmed = reason.trim()
    val valid = trimmed.length >= 5

    AuntieDialog(
        visible = true,
        title = TRIAGE_ARCHIVE_TITLE,
        onDismiss = onDismiss,
        maxWidth = 520.dp,
        closeIcon = Lucide.X,
        hint = TRIAGE_ARCHIVE_HINT,
        leadingIcon = { AuntieIconTile(icon = Lucide.Archive, tone = AuntieStatusTone.Error, size = 36.dp) },
        footer = {
            GhostButton(label = "Cancel", onClick = onDismiss)
            PrimaryButton(
                label = "Archive",
                enabled = valid,
                onClick = { onConfirm(trimmed) },
            )
        },
    ) {
        MultilineField(
            value = reason,
            onValueChange = { reason = it },
            label = "Reason (min 5 chars)",
            placeholder = "e.g. test data from May-17 migration; no real visit occurred",
            minLines = 3,
            modifier = Modifier.fillMaxWidth(),
        )
        if (reason.isNotBlank() && !valid) {
            Text(
                text = "Need at least 5 characters.",
                style = AuntieTheme.typography.mono,
                color = c.error,
            )
        }
    }
}

@Composable
private fun PickerRow(
    label: String,
    sublabel: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    AuntieEntityRow(
        title = label,
        subtitle = sublabel.ifBlank { null },
        selected = selected,
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun BucketGroup(
    bucket: Bucket,
    reports: List<KinCareReport>,
    drafts: List<GeneratedDraft> = emptyList(),
    serviceRates: Map<String, String> = emptyMap(),
    onOpenReport: (sessionId: String) -> Unit = {},
    onOpenDraft: (GeneratedDraft) -> Unit = {},
) {
    DenPanel(
        title = bucket.label,
        trailing = { AuntieChip(label = "${reports.size + drafts.size}", mono = true) },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
            reports.forEach { ReportRow(it, onOpenReport, serviceRates) }
            drafts.forEach { GeneratedDraftRow(it, onOpenDraft) }
        }
    }
}

/**
 * #1563: one `generated_drafts` doc in the Drafts bucket. Same frame as
 * [ReportRow]; the line under the household names the draft's type and date,
 * because the generator writes every kind of message into this collection.
 * Always tappable: it opens the draft in Communicate.
 */
@Composable
internal fun GeneratedDraftRow(draft: GeneratedDraft, onOpenDraft: (GeneratedDraft) -> Unit) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val name = draft.household()
    val shape = RoundedCornerShape(10.dp)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(c.surfaceGlass)
            .border(dims.borderHairline, c.border, shape)
            .clickable(onClickLabel = "Open draft") { onOpenDraft(draft) }
            .padding(horizontal = 15.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(13.dp),
    ) {
        AuntieIconTile(icon = Lucide.FileText, tone = AuntieStatusTone.Neutral, size = 36.dp)
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                text  = name.ifBlank { "Unnamed Kinfolk" },
                style = if (name.isBlank()) {
                    AuntieTheme.typography.titleMedium.copy(fontStyle = FontStyle.Italic, fontWeight = FontWeight.Normal)
                } else {
                    AuntieTheme.typography.titleMedium
                },
                color = if (name.isBlank()) c.textDim else c.textPrimary,
            )
            Text(draftSubmeta(draft), style = AuntieTheme.typography.bodySmall, color = c.textDim)
            kinTaleRowHeadline(draft.title())?.let { KinTaleRowHeadline(it) }
        }
        // #1598: "Draft" everywhere, never the stored `pending` / `generated`.
        AuntieStatusPill(label = "Draft", tone = AuntieStatusTone.Neutral)
    }
}

/**
 * #1563: a draft row's line under the household: its type, then its date (with
 * the year when it is not [currentYear], #1599). Pure; tested.
 */
internal fun draftSubmeta(
    d: GeneratedDraft,
    currentYear: Int = com.tribetails.auntieos.web.screens.invoices.localTodayIso().take(4).toIntOrNull() ?: 0,
): String {
    val type = d.type().replace('_', ' ').ifBlank { "visit report" }
    val whenText = if (d.created().isBlank()) "Date TBD" else kinTaleShortDateTime(d.created(), currentYear)
    return "$type · $whenText"
}

/** #1563: the list search over a draft (household, headline, type, copy). Pure; tested. */
internal fun matchesDraftSearch(d: GeneratedDraft, query: String): Boolean {
    val q = query.lowercase().trim()
    if (q.isBlank()) return true
    return d.household().lowercase().contains(q) ||
        d.title().lowercase().contains(q) ||
        d.type().replace('_', ' ').lowercase().contains(q) ||
        d.body().lowercase().contains(q)
}

/**
 * A KinTale report row, hand-rolled because [AuntieEntityRow] exposes only a
 * String? subtitle and so cannot host the mockup's multi-line submeta + pip
 * stack. Layout mirrors the mockup `.row`: status-icon tile, then a text column
 * (Fraunces name, serviceType · visit-timestamp submeta, media/channel pips),
 * then a trailing status pill. The whole row is tappable when a sessionId is
 * present and routes to the report via [onOpenReport].
 */
@Composable
internal fun ReportRow(
    report: KinCareReport,
    onOpenReport: (sessionId: String) -> Unit = {},
    serviceRates: Map<String, String> = emptyMap(),
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val tone = statusTone(report.status)
    val icon = when (report.status.uppercase()) {
        "SENT"   -> Lucide.MailCheck
        "FAILED" -> Lucide.TriangleAlert
        else     -> Lucide.FileText
    }
    val tappable = report.sessionId.isNotBlank()
    val unnamed = report.kinfolkName.isBlank()

    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    val shape = RoundedCornerShape(10.dp)
    val borderColor = if (hovered && tappable) c.primary.copy(alpha = 0.4f) else c.border

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(c.surfaceGlass)
            .border(dims.borderHairline, borderColor, shape)
            .then(
                if (tappable) {
                    Modifier.clickable(
                        interactionSource = interaction,
                        indication = null,
                        onClick = { onOpenReport(report.sessionId) },
                    )
                } else {
                    Modifier
                },
            )
            .padding(horizontal = 15.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(13.dp),
    ) {
        AuntieIconTile(icon = icon, tone = tone, size = 36.dp)

        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                text  = report.kinfolkName.ifBlank { "Unnamed Kinfolk" },
                style = if (unnamed) {
                    AuntieTheme.typography.titleMedium.copy(fontStyle = FontStyle.Italic, fontWeight = FontWeight.Normal)
                } else {
                    AuntieTheme.typography.titleMedium
                },
                color = if (unnamed) c.textDim else c.textPrimary,
            )
            SubMetaColumn(report, serviceRates)
            kinTaleRowHeadline(report.title)?.let { KinTaleRowHeadline(it) }
        }

        AuntieStatusPill(
            label = report.status.lowercase().replace('_', ' '),
            tone = tone,
        )
    }
}

/** Test tag on a KinTale row's headline line (#2059). */
internal const val KIN_TALE_ROW_HEADLINE_TAG = "kintale-row-headline"
/**
 * #2059: the headline a KinTale row shows, or null when it has none. Blank and
 * whitespace-only both mean none, so the row draws no empty line. Pure; tested.
 */
internal fun kinTaleRowHeadline(title: String?): String? = title?.trim()?.takeIf { it.isNotEmpty() }
/**
 * #2059 (operator ruling 2026-11-13): the tale's headline as the last, lighter
 * line of a Drafts or Sent row, so two tales for one household and KinCare can
 * be told apart. The mock draws no headline, so it takes the submeta's face and
 * dim colour. One line with an ellipsis; hovering it shows the full text as a
 * tooltip (the AuntieInfoTip pattern). A tap still reaches the row.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun KinTaleRowHeadline(text: String) {
    TooltipBox(
        positionProvider = TooltipDefaults.rememberPlainTooltipPositionProvider(),
        tooltip = { PlainTooltip { Text(text, style = AuntieTheme.typography.bodySmall) } },
        state = rememberTooltipState(),
    ) {
        Text(
            text = text,
            style = AuntieTheme.typography.bodySmall,
            color = AuntieTheme.colors.textDim,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.testTag(KIN_TALE_ROW_HEADLINE_TAG),
        )
    }
}
/**
 * The text under the Kinfolk name: serviceType · visit timestamp, then the meta
 * pips (media count, send channel).
 */
@Composable
private fun SubMetaColumn(report: KinCareReport, serviceRates: Map<String, String>) {
    val c = AuntieTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (report.serviceType.isNotBlank()) {
                // #1592: the operator's KinCare name, never the stored key.
                Text(bookingServiceName(report.serviceType, serviceRates), style = AuntieTheme.typography.bodySmall, color = c.textDim)
                Text("·", style = AuntieTheme.typography.bodySmall, color = c.textFaint)
            }
            Text(visitTimestamp(report), style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
        MetaRow(report)
    }
}

@Composable
private fun MetaRow(report: KinCareReport) {
    val c = AuntieTheme.colors
    val mediaCount = report.mediaFileIds.size
    val sentVia    = report.sentVia.takeIf { it.isNotBlank() }

    if (mediaCount == 0 && sentVia == null) return

    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (mediaCount > 0) {
            Pip(icon = Lucide.Images, label = "$mediaCount", tint = c.textDim)
        }
        if (sentVia != null) {
            Pip(icon = Lucide.Send, label = prettySentVia(sentVia), tint = c.textDim)
        }
    }
}

/**
 * Friendly send-channel label. Internal backfill provenance markers
 * ("legacy_visit_logs", "legacy_orphan") are migration bookkeeping, not real
 * delivery channels, so collapse them to "imported" instead of leaking the raw
 * collection name into the operator UI. Real channels (email/sms) pass through.
 */
private fun prettySentVia(sentVia: String): String = when {
    sentVia.isBlank() -> "imported"
    sentVia.startsWith("legacy_") -> "imported"
    else -> sentVia.lowercase()
}

@Composable
private fun Pip(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, tint: Color) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(11.dp))
        Text(label, style = AuntieTheme.typography.mono, color = tint)
    }
}

@Composable
private fun EmptyState() {
    AuntieEmptyState(
        title = "No KinTales found",
        message = "No KinTale records found in this workspace.",
        icon = Lucide.ClipboardList,
    )
}

@Composable
private fun statusTone(status: String): AuntieStatusTone = when (status.uppercase()) {
    "SENT"   -> AuntieStatusTone.Success
    "FAILED" -> AuntieStatusTone.Error
    else     -> AuntieStatusTone.Neutral
}

private fun bucketFor(r: KinCareReport): Bucket = when (r.status.uppercase()) {
    "SENT"   -> Bucket.Sent
    "FAILED" -> Bucket.Failed
    else     -> Bucket.Drafts
}

/**
 * The date a row sorts on: the first non-blank of its date fields, PARSED
 * (#1599). Raw strings put the migrated free text ("September 3, 2025 2:02pm")
 * above every ISO row, so this is epoch milliseconds, null when unreadable.
 */
internal fun sortMillis(r: KinCareReport): Long? = kinTaleSortMillis(
    sequenceOf(r.sentAt, r.updatedAt, r.visitDate, r.createdAt).firstOrNull { it.isNotBlank() },
)

// KT1: operator-chosen ordering for the KinTales list (organizes the Sent bucket).
// Public since #1594, because App holds the list's chosen sort in KinTaleListFilter.
enum class ReportSort(val label: String) {
    Newest("Newest"), Oldest("Oldest"), Kinfolk("Kinfolk A–Z"), Service("Service type"),
}

/**
 * #1594: the KinTale list's search and sort, held by App above the list. A
 * KinTale opened from the list replaces it on screen, so state kept inside the
 * list was gone on Back and the operator landed on an unfiltered list.
 */
@Stable
class KinTaleListFilter(search: String = "", sort: ReportSort = ReportSort.Newest) {
    var search by mutableStateOf(search)
    var sort by mutableStateOf(sort)

    /** Back to an unfiltered list, newest first. */
    fun reset() {
        search = ""
        sort = ReportSort.Newest
    }
}

internal fun sortReports(reports: List<KinCareReport>, mode: ReportSort): List<KinCareReport> = when (mode) {
    ReportSort.Newest  -> reports.sortedWith(kinTaleDateComparator(true, ::sortMillis))
    ReportSort.Oldest  -> reports.sortedWith(kinTaleDateComparator(false, ::sortMillis))
    ReportSort.Kinfolk -> reports.sortedWith(
        compareBy<KinCareReport> { it.kinfolkName.lowercase() }.then(kinTaleDateComparator(true, ::sortMillis)),
    )
    ReportSort.Service -> reports.sortedWith(
        compareBy<KinCareReport> { it.serviceType.lowercase() }.then(kinTaleDateComparator(true, ::sortMillis)),
    )
}

/** SUGGESTION: list-level search predicate (Kinfolk name, headline, service, body). */
internal fun matchesSearch(r: KinCareReport, query: String): Boolean {
    val q = query.lowercase().trim()
    if (q.isBlank()) return true
    return r.kinfolkName.lowercase().contains(q) ||
        r.title.lowercase().contains(q) ||
        r.serviceType.lowercase().contains(q) ||
        r.bodyCopy.lowercase().contains(q)
}

private fun visitTimestamp(r: KinCareReport): String = reportWhen(r, currentYear())
private fun currentYear(): Int =
    com.tribetails.auntieos.web.screens.invoices.localTodayIso().take(4).toIntOrNull() ?: 0
/**
 * #1592: Needs triage named each orphan, and each duplicate candidate, by its
 * document id (`legacy_79`). The operator reads when it was written and whose
 * it is instead; the id still keys every write. Same words as web and Android.
 */
internal const val TRIAGE_ASSIGN_TITLE = "Assign kinfolk to this KinTale"
internal const val TRIAGE_DUPLICATE_TITLE = "Mark this KinTale as a duplicate"
internal const val TRIAGE_ARCHIVE_TITLE = "Archive this KinTale as bad data"
/** Web's archive hint. It said the reason "will be stored on the report doc + activity_log". */
internal const val TRIAGE_ARCHIVE_HINT =
    "Archiving hides the report from these lists and keeps it on file. The reason is recorded in the activity log."
/** When a report was written, by the list's own precedence: an orphan row's lead, never its id. Pure. */
internal fun reportWhen(r: KinCareReport, currentYear: Int): String {
    val raw = sequenceOf(r.visitDate, r.arrivedAt, r.sentAt, r.createdAt)
        .firstOrNull { it.isNotBlank() } ?: return "Date TBD"
    return kinTaleShortDateTime(raw, currentYear)
}
/** A duplicate candidate: whose KinTale and when, never its id. Pure. */
internal fun duplicateCandidateLabel(r: KinCareReport, currentYear: Int): String =
    "${r.kinfolkName.trim().ifBlank { "Unnamed Kinfolk" }} · ${reportWhen(r, currentYear)}"

/**
 * "Sep 3 · 14:02", or "Sep 3, 2025 · 14:02" when it is not [currentYear]
 * (#1599: the list spans more than a year). Echoes non-ISO text.
 */
internal fun kinTaleShortDateTime(iso: String, currentYear: Int): String =
    runCatchingCancellable {
        parseLegacyKinTaleStamp(iso)?.let { s ->
            val time = "${s.hour.toString().padStart(2, '0')}:${s.minute.toString().padStart(2, '0')}"
            val month = MONTHS[s.month - 1]
            return@runCatchingCancellable if (s.year == currentYear) "$month ${s.day} · $time" else "$month ${s.day}, ${s.year} · $time"
        }
        if (iso.length < 16) return@runCatchingCancellable iso
        val year  = iso.substring(0, 4).toInt()
        val month = MONTHS[iso.substring(5, 7).toInt() - 1]
        val day   = iso.substring(8, 10).trimStart('0').ifBlank { "0" }
        val time  = iso.substring(11, 16)
        if (year == currentYear) "$month $day · $time" else "$month $day, $year · $time"
    }.getOrDefault(iso)

private val MONTHS = listOf("Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec")
