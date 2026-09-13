package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
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
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.isUntriagedOrphan
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieChip
import com.tribetails.auntieos.ui.components.AuntieDialog
import com.tribetails.auntieos.ui.components.AuntieEntityRow
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntieIconTile
import com.tribetails.auntieos.ui.components.AuntiePullRefresh
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieSearchField
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.components.StatusToast
import com.tribetails.auntieos.ui.components.ToastKind
import com.tribetails.auntieos.ui.theme.AuntieTheme

private enum class Bucket(val label: String) {
    Failed ("Needs another look"),
    Drafts ("Drafts"),
    Sent   ("Sent"),
}

// Triage sheet routing: null = closed. Each variant carries the orphan being
// triaged so the modal stays in sync after recomposition.
private sealed class TriageSheet {
    data class Assign(val report: KinCareReport)    : TriageSheet()
    data class Duplicate(val report: KinCareReport) : TriageSheet()
    data class Archive(val report: KinCareReport)   : TriageSheet()
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun KinTaleLogsScreen(
    viewModel: AdminDataViewModel = viewModel(),
    onBack: () -> Unit,
    onOpenReport: (sessionId: String) -> Unit = {},
    /**
     * The logs mock's one head control, "Edit templates", which opens the
     * KinTale template editor. Null renders no control at all rather than a
     * button that no-ops (the Buttons.tsx ControlShell rule, applied here).
     */
    onOpenTemplates: (() -> Unit)? = null,
) {
    val reports by viewModel.kinCareReports.collectAsState()
    val isLoading by viewModel.isLoading.collectAsState()
    val kinfolkList by viewModel.kinfolkDirectory.collectAsState()
    val triageResult by viewModel.triageResult.collectAsState()
    // Read for the count chip only. A failed read leaves `isLoading` false and
    // the list empty, so without this the chip would report "0 loaded" about a
    // collection it never managed to read. The screen's own empty state over a
    // failed read is a separate, pre-existing gap and is untouched here.
    val loadError by viewModel.error.collectAsState()
    var searchQuery by remember { mutableStateOf("") }
    var sortMode by remember { mutableStateOf(ReportSort.Newest) }
    var activeSheet by remember { mutableStateOf<TriageSheet?>(null) }

    LaunchedEffect(Unit) {
        viewModel.loadKinCareReports()
        viewModel.loadKinfolkDirectory()
    }

    // Split orphans out and exclude triaged reports from the main buckets.
    // Triaged rows (assigned / duplicate / archived_bad_data) are intentionally
    // hidden - admin already handled them. A future "Triage History" view can
    // surface them again once we add filter chips.
    val orphans = reports.filter { it.isUntriagedOrphan() }
    val nonOrphanActive = reports.filter { !it.isUntriagedOrphan() && it.triageStatus.isBlank() }

    // List search (always on, finished + wired). Client-side filter over loaded
    // KinTales only; no server-side report search exists.
    val matching = nonOrphanActive.filter { matchesSearch(it, searchQuery) }
    val grouped = sortReports(matching, sortMode).groupBy { bucketFor(it) }

    // The two readings of that filter, both decided in one place so the chip in
    // the heading and the list below it can never tell different stories.
    val countLabel = resultCountLabel(
        loaded = nonOrphanActive.size,
        matching = matching.size,
        isLoading = isLoading,
        hasError = loadError != null,
    )
    val outcome = listOutcome(
        loaded = nonOrphanActive.size,
        matching = matching.size,
        orphans = orphans.size,
        isLoading = isLoading,
    )

    AuntieScreenScaffold(title = "KinTales", onBack = onBack) {
        Box(modifier = Modifier.fillMaxSize()) {
            AuntiePullRefresh(
                isRefreshing = isLoading,
                onRefresh = { viewModel.loadKinCareReports() },
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(horizontal = 16.dp),
                    verticalArrangement = Arrangement.spacedBy(20.dp),
                ) {
                    Spacer(Modifier.size(4.dp))

                    DenScreenHeading(
                        kicker   = "The Den · KinTales",
                        title    = "KinTales",
                        subtitle = "Every recap that goes home to a Kinfolk after care",
                        // The mock's `.head .ico`: the ClipboardList tile in the
                        // orange wash, 42dp, before the title block.
                        leading = {
                            AuntieIconTile(icon = Lucide.ClipboardList, tone = AuntieStatusTone.Orange, size = 42.dp)
                        },
                        // The result-count chip (mock SUGGESTION 3), on the band's
                        // badge row now that the trailing slot holds the mock's
                        // control. Absent, not zero, until there is something
                        // real to count.
                        badges = countLabel?.let {
                            { AuntieStatusPill(label = it, mono = true, compact = true) }
                        },
                        // The mock's one head control. There is no "New KinTale"
                        // here: a KinTale is only ever started from a Kin Care
                        // (operator ruling 2026-09-10, #676).
                        trailing = onOpenTemplates?.let { open ->
                            {
                                GhostButton(
                                    label = "Edit templates",
                                    onClick = open,
                                    leading = {
                                        Icon(Lucide.Settings, contentDescription = null, modifier = Modifier.size(14.dp))
                                    },
                                )
                            }
                        },
                    )

                    // List search (always on). Client-side filter over loaded KinTales
                    // only; disclose that limitation (fail loud) so it is not mistaken
                    // for a full-archive search.
                    AuntieSearchField(
                        value = searchQuery,
                        onValueChange = { searchQuery = it },
                        placeholder = "Search KinTales by Kinfolk or body...",
                        leadingIcon = Lucide.Search,
                        onClear = { searchQuery = "" },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.size(6.dp))
                    Text(
                        text  = "Filters the KinTales loaded here, not the full archive.",
                        style = AuntieTheme.typography.labelSmall,
                        color = AuntieTheme.colors.textFaint,
                    )

                    // KT1 (A8): operator-chosen ordering for the list (organizes Sent).
                    SortChipRow(selected = sortMode, onSelect = { sortMode = it })

                    // The triage queue is drawn from the outcome above, never
                    // filtered by the search: an untriaged migration row is work
                    // owed regardless of what the operator typed, and hiding it
                    // behind a query would quietly retire it.
                    if (orphans.isNotEmpty()) {
                        NeedsTriageSection(
                            orphans     = orphans,
                            onAssign    = { activeSheet = TriageSheet.Assign(it) },
                            onDuplicate = { activeSheet = TriageSheet.Duplicate(it) },
                            onArchive   = { activeSheet = TriageSheet.Archive(it) },
                        )
                    }

                    when (outcome) {
                        // The pull-refresh indicator is already saying this.
                        ListOutcome.Loading -> Unit
                        ListOutcome.Empty   -> EmptyState()
                        ListOutcome.NoMatch -> NoMatchState()
                        ListOutcome.Rows    -> Bucket.entries.forEach { bucket ->
                            val items = grouped[bucket].orEmpty()
                            if (items.isNotEmpty()) {
                                BucketGroup(
                                    bucket       = bucket,
                                    reports      = items,
                                    onOpenReport = onOpenReport,
                                )
                            }
                        }
                    }

                    Spacer(Modifier.size(4.dp))
                }
            }

            // Status toast for triage actions. Anchored to top of the screen so
            // it stays visible even when the modal closes mid-action.
            StatusToast(
                visible = triageResult != null,
                message = triageResult?.message.orEmpty(),
                kind    = if (triageResult?.success == true) ToastKind.Success else ToastKind.Error,
                onDismiss = { viewModel.clearTriageResult() },
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(horizontal = 16.dp),
            )
        }
    }

    // Triage modals - at most one open at a time, gated by activeSheet.
    when (val sheet = activeSheet) {
        is TriageSheet.Assign -> AssignKinfolkDialog(
            report   = sheet.report,
            kinfolk  = kinfolkList,
            onCancel = { activeSheet = null },
            onConfirm = { kinfolk ->
                val fullName = listOf(kinfolk.firstName, kinfolk.lastName)
                    .filter { it.isNotBlank() }
                    .joinToString(" ")
                    .ifBlank { "Unnamed Kinfolk" }
                viewModel.assignOrphanReport(sheet.report.id, kinfolk.id, fullName)
                activeSheet = null
            },
        )
        is TriageSheet.Duplicate -> MarkDuplicateDialog(
            report      = sheet.report,
            candidates  = nonOrphanActive,
            onCancel    = { activeSheet = null },
            onConfirm   = { canonicalId ->
                viewModel.markOrphanAsDuplicate(sheet.report.id, canonicalId)
                activeSheet = null
            },
        )
        is TriageSheet.Archive -> ArchiveBadDataDialog(
            report    = sheet.report,
            onCancel  = { activeSheet = null },
            onConfirm = { reason ->
                viewModel.archiveOrphanAsBad(sheet.report.id, reason)
                activeSheet = null
            },
        )
        null -> Unit
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Needs Triage section - orphan list + per-row action buttons
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun NeedsTriageSection(
    orphans: List<KinCareReport>,
    onAssign: (KinCareReport) -> Unit,
    onDuplicate: (KinCareReport) -> Unit,
    onArchive: (KinCareReport) -> Unit,
) {
    DenPanel(
        title    = "Needs triage",
        subtitle = "Pre-cutover visit_logs migrated without a Kinfolk link. Assign, mark duplicate, or archive each.",
        trailing = {
            AuntieStatusPill(
                label = "${orphans.size} orphan${if (orphans.size == 1) "" else "s"}",
                tone  = AuntieStatusTone.Orange,
                mono  = true,
            )
        },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            // Warning banner: surfaces the migration orphans that still need an
            // admin decision. Copy is verbatim from the prior source.
            AuntieBanner(
                tone = AuntieBannerTone.Warning,
                icon = Lucide.TriangleAlert,
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
                text  = report.id.ifBlank { "(no id)" },
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
            PrimaryButton(
                label   = "Assign",
                onClick = onAssign,
                modifier = Modifier.weight(1f),
                leading = { Icon(Lucide.UserPlus, contentDescription = null, modifier = Modifier.size(14.dp)) },
            )
            GhostButton(
                label   = "Duplicate",
                onClick = onDuplicate,
                modifier = Modifier.weight(1f),
                leading = { Icon(Lucide.Copy, contentDescription = null, modifier = Modifier.size(14.dp)) },
            )
            GhostButton(
                label   = "Archive",
                onClick = onArchive,
                modifier = Modifier.weight(1f),
                leading = { Icon(Lucide.Archive, contentDescription = null, modifier = Modifier.size(14.dp)) },
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

// ─────────────────────────────────────────────────────────────────────────────
// Triage dialogs (Den modal scaffold)
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun AssignKinfolkDialog(
    report: KinCareReport,
    kinfolk: List<Kinfolk>,
    onCancel: () -> Unit,
    onConfirm: (Kinfolk) -> Unit,
) {
    var selected by remember { mutableStateOf<Kinfolk?>(null) }
    var query by remember { mutableStateOf("") }
    val filtered = remember(kinfolk, query) {
        val q = query.lowercase().trim()
        if (q.isBlank()) kinfolk
        else kinfolk.filter {
            "${it.firstName} ${it.lastName}".lowercase().contains(q) ||
                it.phoneNumber.lowercase().contains(q) ||
                it.email.lowercase().contains(q)
        }
    }

    AuntieDialog(
        visible = true,
        title = "Assign Kinfolk to KinTale ${report.id}",
        onDismiss = onCancel,
        maxWidth = 520.dp,
        closeIcon = Lucide.X,
        leadingIcon = { AuntieIconTile(icon = Lucide.UserPlus, tone = AuntieStatusTone.Orange, size = 36.dp) },
        footer = {
            GhostButton(label = "Cancel", onClick = onCancel)
            PrimaryButton(
                label = "Assign",
                enabled = selected != null,
                onClick = { selected?.let(onConfirm) },
            )
        },
    ) {
        AuntieField(
            value = query,
            onValueChange = { query = it },
            placeholder = "Search kinfolk by name, phone, or email",
            leading = { Icon(Lucide.Search, contentDescription = null) },
            modifier = Modifier.fillMaxWidth(),
        )
        if (kinfolk.isEmpty()) {
            EmptyHint("No kinfolk loaded. Pull to refresh.", error = true)
        } else {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 320.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                if (filtered.isEmpty()) {
                    EmptyHint("No matching kinfolk.")
                } else {
                    filtered.forEach { k ->
                        val name = "${k.firstName} ${k.lastName}".trim().ifBlank { "Unnamed Kinfolk" }
                        val sub = listOfNotNull(
                            k.phoneNumber.ifBlank { null },
                            k.email.ifBlank { null },
                        ).joinToString(" · ")
                        AuntieEntityRow(
                            title = name,
                            subtitle = sub.ifBlank { null },
                            selected = selected?.id == k.id,
                            onClick = { selected = k },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MarkDuplicateDialog(
    report: KinCareReport,
    candidates: List<KinCareReport>,
    onCancel: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var selectedId by remember { mutableStateOf("") }
    var query by remember { mutableStateOf("") }
    val filtered = remember(candidates, query) {
        val q = query.lowercase().trim()
        val pool = candidates.filter { it.id != report.id }
        if (q.isBlank()) pool.take(50)
        else pool.filter {
            it.kinfolkName.lowercase().contains(q) ||
                it.bodyCopy.lowercase().contains(q) ||
                it.id.lowercase().contains(q)
        }
    }

    AuntieDialog(
        visible = true,
        title = "Mark ${report.id} as duplicate",
        onDismiss = onCancel,
        maxWidth = 520.dp,
        closeIcon = Lucide.X,
        hint = "Pick the existing KinTale that this orphan duplicates. Triaged rows are hidden from search.",
        leadingIcon = { AuntieIconTile(icon = Lucide.Copy, tone = AuntieStatusTone.Purple, size = 36.dp) },
        footer = {
            GhostButton(label = "Cancel", onClick = onCancel)
            PrimaryButton(
                label = "Mark duplicate",
                enabled = selectedId.isNotBlank(),
                onClick = { onConfirm(selectedId) },
            )
        },
    ) {
        AuntieField(
            value = query,
            onValueChange = { query = it },
            placeholder = "Search by kinfolk name, body, or report ID",
            leading = { Icon(Lucide.Search, contentDescription = null) },
            modifier = Modifier.fillMaxWidth(),
        )
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 320.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (filtered.isEmpty()) {
                EmptyHint("No matching reports.")
            } else {
                filtered.forEach { canon ->
                    // id and name joined with a plain hyphen per the no-em-dash rule.
                    AuntieEntityRow(
                        title = "${canon.id} - ${canon.kinfolkName.ifBlank { "Unnamed" }}",
                        subtitle = bodyPreview(canon.bodyCopy),
                        selected = selectedId == canon.id,
                        onClick = { selectedId = canon.id },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}

@Composable
private fun ArchiveBadDataDialog(
    report: KinCareReport,
    onCancel: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    val c = AuntieTheme.colors
    var reason by remember { mutableStateOf("") }
    val trimmed = reason.trim()
    val valid = trimmed.length >= 5

    AuntieDialog(
        visible = true,
        title = "Archive ${report.id} as bad data",
        onDismiss = onCancel,
        maxWidth = 520.dp,
        closeIcon = Lucide.X,
        hint = "Soft-archive: the report stays in Firestore for audit but is hidden from the active buckets. Reason is recorded in activity_log.",
        leadingIcon = { AuntieIconTile(icon = Lucide.Archive, tone = AuntieStatusTone.Error, size = 36.dp) },
        footer = {
            GhostButton(label = "Cancel", onClick = onCancel)
            PrimaryButton(
                label = "Archive",
                enabled = valid,
                onClick = { onConfirm(trimmed) },
            )
        },
    ) {
        AuntieField(
            value = reason,
            onValueChange = { reason = it },
            label = "Archive reason (≥ 5 chars)",
            placeholder = "e.g. test data from May 10 migration",
            singleLine = false,
            minLines = 2,
            maxLines = 4,
            isError = reason.isNotEmpty() && !valid,
            modifier = Modifier.fillMaxWidth(),
        )
        if (reason.isNotEmpty() && !valid) {
            Text(
                text = "Reason must be at least 5 characters.",
                style = AuntieTheme.typography.labelSmall,
                color = c.error,
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Report buckets - Den panel + status-icon-tile rows
// ─────────────────────────────────────────────────────────────────────────────

@Composable
private fun BucketGroup(
    bucket: Bucket,
    reports: List<KinCareReport>,
    onOpenReport: (sessionId: String) -> Unit = {},
) {
    // The mock's `.bucket-head`: the label, then the count as the mono note on
    // the rule (`DenPanel.meta`), never a pill that reads as a status.
    DenPanel(
        title = bucket.label,
        meta = "${reports.size}",
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
            reports.forEach { ReportRow(it, onOpenReport) }
        }
    }
}

/**
 * A KinTale report row, hand-rolled because [AuntieEntityRow] exposes only a
 * String? subtitle and so cannot host the multi-line submeta + pip stack. Layout
 * mirrors the web counterpart's row: a status-icon tile, then a text column
 * (Fraunces name, serviceType · visit-timestamp submeta, media/channel pips),
 * then a trailing status pill. The whole row is tappable when a sessionId is
 * present and routes to the report via [onOpenReport].
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ReportRow(report: KinCareReport, onOpenReport: (sessionId: String) -> Unit = {}) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val tone = statusTone(report.status)
    val icon = statusIcon(report.status)
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
            SubMetaColumn(report)
        }

        // The mock's `.pill`: the compact capsule at the row's right edge.
        AuntieStatusPill(
            label = report.status.lowercase().replace('_', ' '),
            tone = tone,
            compact = true,
        )
    }
}

/**
 * The text under the Kinfolk name: serviceType · visit timestamp, then the meta
 * pips (media count, send channel).
 */
@Composable
private fun SubMetaColumn(report: KinCareReport) {
    val c = AuntieTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            val serviceType = report.serviceType.orEmpty()
            if (serviceType.isNotBlank()) {
                Text(serviceType, style = AuntieTheme.typography.bodySmall, color = c.textDim)
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
private fun Pip(icon: ImageVector, label: String, tint: Color) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(11.dp))
        Text(label, style = AuntieTheme.typography.mono, color = tint)
    }
}

@Composable
private fun EmptyState() {
    DenPanel(title = "KinTales") {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            AuntieIconTile(icon = Lucide.ClipboardList, tone = AuntieStatusTone.Neutral, size = 44.dp)
            Text(
                text = "No KinTales found",
                style = AuntieTheme.typography.headlineSmall,
                color = AuntieTheme.colors.textPrimary,
            )
            EmptyHint("No KinTale records found in this workspace.")
        }
    }
}

/**
 * A search that matched none of the loaded KinTales, said out loud.
 *
 * Deliberately worded apart from [EmptyState]'s "No KinTales found": one means
 * the workspace has none, the other means this query has none, and a screen that
 * renders the same nothing for both is the defect. Same copy as the web screen's
 * own no-match hint.
 */
@Composable
private fun NoMatchState() {
    DenPanel(title = "KinTales") {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            AuntieIconTile(icon = Lucide.Search, tone = AuntieStatusTone.Neutral, size = 44.dp)
            Text(
                text  = "Nothing in the loaded KinTales matches this search.",
                style = AuntieTheme.typography.headlineSmall,
                color = AuntieTheme.colors.textPrimary,
            )
            EmptyHint("Clear the search to see them all again.")
        }
    }
}

@Composable
private fun statusTone(status: String): AuntieStatusTone = when (status.uppercase()) {
    "SENT"   -> AuntieStatusTone.Success
    "FAILED" -> AuntieStatusTone.Error
    else     -> AuntieStatusTone.Neutral
}

private fun statusIcon(status: String): ImageVector = when (status.uppercase()) {
    "SENT"   -> Lucide.MailCheck
    "FAILED" -> Lucide.TriangleAlert
    else     -> Lucide.FileText
}

private fun bucketFor(r: KinCareReport): Bucket = when (r.status.uppercase()) {
    "SENT"   -> Bucket.Sent
    "FAILED" -> Bucket.Failed
    else     -> Bucket.Drafts
}

/** KT1: the sort selector: one chip per ReportSort, wraps on a narrow screen. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SortChipRow(selected: ReportSort, onSelect: (ReportSort) -> Unit) {
    FlowRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        ReportSort.entries.forEach { mode ->
            AuntieChip(label = mode.label, selected = mode == selected, onClick = { onSelect(mode) })
        }
    }
}

/** Raw ISO date key for ordering (first non-blank). Mirror of the web sortKey. */
private fun sortKey(r: KinCareReport): String =
    sequenceOf(r.sentAt, r.visitDate, r.arrivedAt, r.createdAt).firstOrNull { !it.isNullOrBlank() } ?: ""

/** KT1 (A8): operator-chosen ordering for the KinTales list. Mirror of web ReportSort. */
internal enum class ReportSort(val label: String) {
    Newest("Newest"), Oldest("Oldest"), Kinfolk("Kinfolk A–Z"), Service("Service type"),
}

internal fun sortReports(reports: List<KinCareReport>, mode: ReportSort): List<KinCareReport> = when (mode) {
    ReportSort.Newest  -> reports.sortedByDescending { sortKey(it) }
    ReportSort.Oldest  -> reports.sortedBy { sortKey(it) }
    ReportSort.Kinfolk -> reports.sortedWith(
        compareBy<KinCareReport> { it.kinfolkName.lowercase() }.thenByDescending { sortKey(it) },
    )
    ReportSort.Service -> reports.sortedWith(
        compareBy<KinCareReport> { it.serviceType.orEmpty().lowercase() }.thenByDescending { sortKey(it) },
    )
}

/**
 * The result-count chip's text, or null for "render no chip at all".
 *
 * Null is the whole reason this is a function. Before the first read lands, or
 * after one has failed, there is no count, and a pill reading "0 loaded" over a
 * collection nobody has managed to read is a confident zero about an unknown,
 * which is the exact failure class this app refuses. A FAILED read is the
 * sharper half of that: it leaves `isLoading` false and the list empty, so
 * nothing else in the state distinguishes it from an empty workspace.
 *
 * Rows already on screen settle it either way. A refresh, failed or in flight,
 * over twelve visible rows still leaves twelve visible rows, so the chip keeps
 * describing them rather than blinking out.
 *
 * "loaded" rather than a bare number, and the same word the web screen uses: it
 * is a fact about the rows this screen has, and the line under the search field
 * already says those rows are what the search covers.
 *
 * Both platforms pick between the two forms by whether anything was actually
 * excluded, not by whether a control is set, so a search that happens to match
 * every row reads as the plain count rather than as the noise "12 of 12".
 */
internal fun resultCountLabel(
    loaded: Int,
    matching: Int,
    isLoading: Boolean,
    hasError: Boolean,
): String? {
    if (loaded == 0 && (isLoading || hasError)) return null
    return if (matching == loaded) "$loaded loaded" else "$matching of $loaded loaded"
}

/** What the list area below the triage section should render. See [listOutcome]. */
internal enum class ListOutcome { Loading, Empty, NoMatch, Rows }

/**
 * Which of the four list states is true, decided once so the buckets and the
 * copy can never disagree.
 *
 * [NoMatch] exists because it used to be unrepresentable: a search that excluded
 * every row left this screen rendering a search field over nothing at all, with
 * no line saying why, and no way to tell that from an empty workspace. The two
 * are different facts and the screen now says which one it means.
 *
 * Orphans are counted separately from [loaded] and never suppress the triage
 * section: a search that empties the list does not settle an untriaged migration
 * row, and orphans on their own are content, not an empty workspace.
 */
internal fun listOutcome(loaded: Int, matching: Int, orphans: Int, isLoading: Boolean): ListOutcome =
    when {
        loaded == 0 && orphans == 0 && isLoading -> ListOutcome.Loading
        loaded == 0 && orphans == 0              -> ListOutcome.Empty
        loaded > 0 && matching == 0              -> ListOutcome.NoMatch
        else                                     -> ListOutcome.Rows
    }

/** List-level search predicate (Kinfolk name, service, body). */
internal fun matchesSearch(r: KinCareReport, query: String): Boolean {
    val q = query.lowercase().trim()
    if (q.isBlank()) return true
    return r.kinfolkName.lowercase().contains(q) ||
        r.serviceType.orEmpty().lowercase().contains(q) ||
        r.bodyCopy.lowercase().contains(q)
}

private fun visitTimestamp(r: KinCareReport): String {
    val raw = sequenceOf(r.visitDate, r.arrivedAt, r.sentAt, r.createdAt)
        .firstOrNull { !it.isNullOrBlank() } ?: return "Date TBD"
    return shortDateTime(raw)
}

private fun shortDateTime(iso: String): String =
    runCatching {
        if (iso.length < 16) return@runCatching iso
        val month = MONTHS[iso.substring(5, 7).toInt() - 1]
        val day   = iso.substring(8, 10).trimStart('0').ifBlank { "0" }
        val time  = iso.substring(11, 16)
        "$month $day · $time"
    }.getOrDefault(iso)

private val MONTHS = listOf("Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec")
