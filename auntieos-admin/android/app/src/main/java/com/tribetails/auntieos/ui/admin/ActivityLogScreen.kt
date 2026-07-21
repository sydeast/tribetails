package com.tribetails.auntieos.ui.admin

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.composables.icons.lucide.Activity
import com.composables.icons.lucide.Bell
import com.composables.icons.lucide.CalendarPlus
import com.composables.icons.lucide.Flag
import com.composables.icons.lucide.History
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Settings2
import com.composables.icons.lucide.ShieldCheck
import com.composables.icons.lucide.TriangleAlert
import com.composables.icons.lucide.UserCheck
import com.tribetails.auntieos.data.admin.ActivityLogEntry
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieChip
import com.tribetails.auntieos.ui.components.AuntieIconTile
import com.tribetails.auntieos.ui.components.AuntiePullRefresh
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieSearchField
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.AuntieEntityRow
import com.tribetails.auntieos.ui.components.AuntieModal
import com.tribetails.auntieos.ui.components.formatTime
import com.tribetails.auntieos.ui.theme.AuntieTheme
import java.time.LocalDate

/**
 * Activity log (hash-chain audit trail) in the Den aesthetic. Ported from the
 * web Den layout (web/.../screens/activity/ActivityLogScreen.kt) while keeping
 * the Android [AdminDataViewModel] contract: entries come from
 * [AdminDataViewModel.activityLog] and refresh runs through [loadActivityLog].
 *
 * Fail-loud honesty (per project policy), mirroring the web spec:
 *  - The cryptographic "Chain verified" badge, the "Re-verify" action
 *    (verifyActivityLogChain via [AdminDataViewModel.verifyChain]), and the
 *    per-entry seq/hash column from the Den mockup are all live. The Android
 *    [ActivityLogEntry] model carries the real seq/prevHash/entryHash fields,
 *    so a sealed row shows "#seq · <hash8>" and a legacy row that predates the
 *    chain shows an honest "unchained" pill. Nothing is fabricated.
 *  - Timestamp parsing tolerates non-ISO values without silently collapsing
 *    every row into one "Undated" group; if a meaningful share of rows have
 *    unparseable timestamps we raise a visible Warning banner so the
 *    writer/reader contract mismatch is not hidden.
 */

// Den filter buckets. Each maps a set of actionType prefixes onto a chip. "All"
// passes everything through. Filtering is purely client-side over the already
// loaded entries, so no new data call is introduced.
private enum class ActivityFilter(val label: String) {
    All("All"),
    Auth("Auth"),
    Bookings("Bookings"),
    KinTales("KinTales"),
    Notifications("Notifications"),
    Admin("Admin"),
}

private fun ActivityFilter.matches(actionType: String): Boolean {
    if (this == ActivityFilter.All) return true
    val a = actionType.uppercase()
    return when (this) {
        ActivityFilter.All           -> true
        ActivityFilter.Auth          -> a.startsWith("AUTH") || a.contains("LOGIN") || a.contains("LOGOUT")
        ActivityFilter.Bookings      -> a.startsWith("BOOKING") || a.startsWith("KINCARE") ||
            a.contains("SESSION") || a.contains("VISIT")
        ActivityFilter.KinTales      -> a.contains("KINTALE") || a.contains("CONTENT") ||
            a.contains("DRAFT") || a.contains("REPORT")
        ActivityFilter.Notifications -> a.contains("NOTIFICATION") || a.contains("NOTIF")
        ActivityFilter.Admin         -> a.startsWith("ADMIN") || a.contains("TRIAGE") ||
            a.startsWith("UPDATE_SETTINGS") || a.startsWith("SETTINGS")
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ActivityLogScreen(
    viewModel: AdminDataViewModel = viewModel(),
    onBack: () -> Unit,
) {
    val entries   by viewModel.activityLog.collectAsState()
    val isLoading by viewModel.isLoading.collectAsState()
    val chainVerify by viewModel.chainVerify.collectAsState()

    LaunchedEffect(Unit) { viewModel.loadActivityLog() }

    var filter by remember { mutableStateOf(ActivityFilter.All) }
    var query by remember { mutableStateOf("") }
    // Clicked entry opens a read-only detail overlay (spec 22 item 1).
    var selectedEntry by remember { mutableStateOf<ActivityLogEntry?>(null) }

    selectedEntry?.let { entry ->
        ActivityDetailModal(entry = entry, onDismiss = { selectedEntry = null })
    }

    AuntieScreenScaffold(title = "Activity Log", onBack = onBack) {
        AuntiePullRefresh(
            isRefreshing = isLoading,
            onRefresh    = { viewModel.loadActivityLog() },
            modifier     = Modifier.weight(1f),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = 16.dp, vertical = 16.dp),
            ) {
                DenScreenHeading(
                    kicker     = "The Den · Activity log",
                    title      = "Every move,",
                    accentTail = "sealed.",
                    subtitle   = "The append-only audit trail. Every login, edit, and system event the app records, sealed into the hash chain.",
                )
                Spacer(Modifier.height(20.dp))

                ChainIntegrityPanel(
                    entryCount  = entries.size,
                    verifyState = chainVerify,
                    onVerify    = { viewModel.verifyChain() },
                )
                Spacer(Modifier.height(16.dp))

                FilterChipRow(selected = filter, onSelect = { filter = it })
                Spacer(Modifier.height(12.dp))

                AuntieSearchField(
                    value         = query,
                    onValueChange = { query = it },
                    placeholder   = "Search actor, action, target",
                    leadingIcon   = Lucide.Activity,
                    onClear       = { query = "" },
                    modifier      = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(16.dp))

                LogPanel(
                    all                = entries,
                    isLoading          = isLoading,
                    filter             = filter,
                    query              = query,
                    onRowClick         = { selectedEntry = it },
                )
            }
        }
    }
}

@Composable
private fun LogPanel(
    all: List<ActivityLogEntry>,
    isLoading: Boolean,
    filter: ActivityFilter,
    query: String,
    onRowClick: (ActivityLogEntry) -> Unit,
) {
    DenPanel(
        title    = "Sealed events",
        subtitle = "Newest first. Grouped by day.",
    ) {
        if (all.isEmpty()) {
            if (isLoading) {
                com.tribetails.auntieos.ui.components.EmptyHint("Loading the audit trail.")
            } else {
                EmptyState()
            }
            return@DenPanel
        }

        // VM already sorts newest-first (loadActivityLog), but re-sort defensively
        // so a different feed path can't quietly reorder the rendered list.
        val sortedAll = all.sortedByDescending { it.timestamp }

        // Timestamp-contract guard: if a meaningful share of rows have unparseable
        // timestamps, the writer may be storing Firestore Timestamp objects instead
        // of ISO-8601 strings. Surface that loudly rather than collapsing to one
        // "Undated" bucket and pretending the ordering is meaningful.
        val unparseable = sortedAll.count { !isParseableTimestamp(it.timestamp) }
        if (unparseable > 0 && unparseable >= sortedAll.size / 2) {
            AuntieBanner(
                tone   = AuntieBannerTone.Warning,
                title  = "Timestamps look unparseable",
                icon   = Lucide.TriangleAlert,
                dashed = true,
            ) {
                Text(
                    "$unparseable of ${sortedAll.size} entries have a timestamp this screen can't read as ISO-8601. " +
                        "The audit writer may be storing a Firestore Timestamp object instead of a string, " +
                        "which breaks day-grouping and ordering. Day/time shown as best-effort below.",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim,
                )
            }
            Spacer(Modifier.height(12.dp))
        }

        val visible = sortedAll
            .filter { filter.matches(it.actionType) }
            .filter { matchesQuery(it, query) }

        if (visible.isEmpty()) {
            NoMatchesState()
            return@DenPanel
        }

        // Stable insertion-ordered grouping; list is already newest-first.
        val todayKey = LocalDate.now().toString()
        val yesterdayKey = isoDateMinusOneDay(todayKey)
        val grouped = visible.groupBy { it.timestamp.take(10) }

        Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            grouped.forEach { (dateIso, dayEntries) ->
                DaySeparator(
                    label = relativeDayLabel(dateIso, todayKey, yesterdayKey),
                    count = dayEntries.size,
                )
                dayEntries.forEach { entry -> ActivityRow(entry, onClick = { onRowClick(entry) }) }
            }
        }
    }
}

/**
 * The Den "chain integrity" surface.
 *
 * Re-verify calls the deployed `verifyActivityLogChain` admin callable (via
 * AdminDataViewModel.verifyChain) and renders the REAL verdict: a teal "Chain
 * verified" badge with the sealed seq range + scanned count, or a fail-loud
 * coral break naming the first anomalous seq/code. Nothing is fabricated: before
 * the first run it just reports the real loaded entry count. The per-row
 * seq/entryHash seal renders in LogPanel from the real entry model fields.
 */
@Composable
internal fun ChainIntegrityPanel(
    entryCount: Int,
    verifyState: ChainVerifyUiState,
    onVerify: () -> Unit,
) {
    val c = AuntieTheme.colors
    val verifying = verifyState is ChainVerifyUiState.Loading
    DenPanel(
        title    = "Hash chain",
        subtitle = "writeAuditEntry seals each event into a SHA-256 chain.",
        trailing = {
            GhostButton(
                label = if (verifying) "Verifying..." else "Re-verify",
                onClick = onVerify,
                enabled = !verifying,
            )
        },
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            val verdictOk = (verifyState as? ChainVerifyUiState.Done)?.result?.ok == true
            AuntieIconTile(
                icon = Lucide.ShieldCheck,
                tone = if (verdictOk) AuntieStatusTone.Success else AuntieStatusTone.Teal,
                size = 36.dp,
            )
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    "$entryCount ${if (entryCount == 1) "entry" else "entries"} loaded",
                    style = AuntieTheme.typography.titleSmall,
                    color = c.textPrimary,
                )
                Text(
                    text  = chainVerdictLine(verifyState),
                    style = AuntieTheme.typography.mono,
                    color = when (verifyState) {
                        is ChainVerifyUiState.Error -> c.error
                        is ChainVerifyUiState.Done  -> if (verifyState.result.ok) c.textDim else c.error
                        else -> c.textDim
                    },
                )
            }
        }

        // Fail-loud break detail when the chain does not validate.
        val broken = (verifyState as? ChainVerifyUiState.Done)?.result?.takeIf { !it.ok }
        if (broken != null) {
            Spacer(Modifier.height(12.dp))
            AuntieBanner(
                tone   = AuntieBannerTone.Error,
                title  = "Hash chain integrity broken",
                icon   = Lucide.ShieldCheck,
            ) {
                Text(
                    buildString {
                        append("First break")
                        broken.anomalySeq?.let { append(" at seq $it") }
                        broken.anomalyCode?.let { append(": $it") }
                        append(". This audit trail may have been tampered with.")
                    },
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }
        }
    }
}

/**
 * Per-row hash-chain seal label: "#<seq> · <first 8 of entryHash>" when the entry
 * is sealed, or null when it has no seq (legacy/unchained). Never fabricates a
 * hash. Mirrors the web seqHashLabel. Pure; unit-tested.
 */
internal fun seqHashLabel(seq: Long?, entryHash: String): String? {
    if (seq == null) return null
    val short = entryHash.take(8)
    return if (short.isNotBlank()) "#$seq · $short" else "#$seq"
}

/** Honest one-line verdict for the chain panel; never fabricates a pass. */
internal fun chainVerdictLine(state: ChainVerifyUiState): String = when (state) {
    is ChainVerifyUiState.Idle -> "Tap Re-verify to check the chain integrity."
    is ChainVerifyUiState.Loading -> "Verifying the SHA-256 chain..."
    is ChainVerifyUiState.Error -> "Chain verification failed: ${state.message}"
    is ChainVerifyUiState.Done -> {
        val r = state.result
        if (r.ok) {
            val seq = if (r.firstSeq != null && r.lastSeq != null) "seq ${r.firstSeq}..${r.lastSeq}, " else ""
            val unchained = if (r.unchainedCount > 0) ", ${r.unchainedCount} legacy unchained" else ""
            "Chain verified, ${seq}${r.scanned} scanned, 0 anomalies$unchained"
        } else {
            "Chain BROKEN" + (r.anomalyCode?.let { " ($it)" } ?: "")
        }
    }
}

@Composable
private fun FilterChipRow(selected: ActivityFilter, onSelect: (ActivityFilter) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        ActivityFilter.entries.forEach { f ->
            AuntieChip(
                label    = f.label,
                selected = f == selected,
                onClick  = { onSelect(f) },
            )
        }
    }
}

@Composable
private fun DaySeparator(label: String, count: Int) {
    val c = AuntieTheme.colors
    Text(
        text     = "${label.uppercase()} · $count",
        style    = AuntieTheme.typography.mono,
        color    = c.textFaint,
        modifier = Modifier.padding(top = 14.dp, bottom = 6.dp),
    )
}

/**
 * Read-only detail overlay for a clicked activity entry (spec 22 item 1). Surfaces
 * the FULL record the row truncates. All fields already on the model; nothing faked.
 */
@Composable
private fun ActivityDetailModal(entry: ActivityLogEntry, onDismiss: () -> Unit) {
    val target = listOf(entry.targetCollection, entry.targetId).filter { it.isNotBlank() }.joinToString("/")
    AuntieModal(
        onDismissRequest = onDismiss,
        title = humanizeAction(entry.actionType),
        confirmButton = { GhostButton(label = "Close", onClick = onDismiss) },
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            DetailKv("When", entry.timestamp.ifBlank { "-" })
            DetailKv("Action", entry.actionType.ifBlank { "-" })
            DetailKv("Status", entry.status.ifBlank { "-" })
            DetailKv("Actor", entry.actorId.ifBlank { "-" })
            if (entry.description.isNotBlank()) DetailKv("Detail", entry.description)
            DetailKv("Target", target.ifBlank { "-" })
        }
    }
}

@Composable
private fun DetailKv(label: String, value: String) {
    val c = AuntieTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label.uppercase(), style = AuntieTheme.typography.labelSmall, color = c.kinfolkOrange)
        Text(value, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
    }
}

@Composable
internal fun ActivityRow(entry: ActivityLogEntry, onClick: () -> Unit) {
    val c = AuntieTheme.colors
    val isFailure = entry.status.equals("FAILURE", ignoreCase = true) ||
        entry.status.equals("ERROR", ignoreCase = true)
    val tone = if (isFailure) AuntieStatusTone.Error else categoryTone(entry.actionType)

    AuntieEntityRow(
        title    = humanizeAction(entry.actionType),
        subtitle = rowContext(entry).ifBlank { null },
        onClick  = onClick,
        leading = {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text(
                    text     = shortTime(entry.timestamp),
                    style    = AuntieTheme.typography.mono,
                    color    = c.textFaint,
                    modifier = Modifier.width(54.dp),
                )
                AuntieIconTile(
                    icon = actionIcon(entry.actionType, entry.status),
                    tone = tone,
                    size = 30.dp,
                )
            }
        },
        trailing = {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (entry.status.isNotBlank()) {
                    AuntieStatusPill(
                        label = entry.status,
                        tone  = statusTone(entry.status),
                        mono  = true,
                    )
                }
                // Per-row seq + entryHash column (Den mockup right rail), always on.
                // Bound to the REAL hash-chain seal: a sealed entry shows
                // "#seq · <hash8>"; a legacy entry that predates the chain shows the
                // honest "unchained" pill. Never fabricates a hash.
                val sealLabel = seqHashLabel(entry.seq, entry.entryHash)
                if (sealLabel != null) {
                    AuntieStatusPill(label = sealLabel, tone = AuntieStatusTone.Teal, mono = true)
                } else {
                    AuntieStatusPill(label = "unchained", tone = AuntieStatusTone.Muted, mono = true)
                }
            }
        },
    )
}

@Composable
private fun EmptyState() {
    val c = AuntieTheme.colors
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        AuntieIconTile(icon = Lucide.History, tone = AuntieStatusTone.Muted, size = 48.dp)
        Text("The audit trail is quiet", style = AuntieTheme.typography.headlineSmall, color = c.textPrimary)
        Text(
            text  = "Events will appear here once audit hooks start writing: logins, kinfolk edits, settings changes, reconcile runs. An empty collection means nothing has been sealed yet, not that anything is broken.",
            style = AuntieTheme.typography.bodyMedium,
            color = c.textDim,
        )
    }
}

@Composable
private fun NoMatchesState() {
    val c = AuntieTheme.colors
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        AuntieIconTile(icon = Lucide.Activity, tone = AuntieStatusTone.Muted, size = 48.dp)
        Text("No matching events", style = AuntieTheme.typography.titleLarge, color = c.textPrimary)
        Text(
            text  = "Nothing matches the current filter or search. Try a different category or clear the search.",
            style = AuntieTheme.typography.bodyMedium,
            color = c.textDim,
        )
    }
}

// ---------- styling + formatting helpers (pure, JVM-testable) ----------

private fun matchesQuery(entry: ActivityLogEntry, query: String): Boolean {
    val q = query.trim()
    if (q.isBlank()) return true
    val hay = listOf(
        entry.actionType,
        humanizeAction(entry.actionType),
        entry.description,
        entry.actorId,
        entry.targetId,
        entry.targetCollection,
        entry.status,
    ).joinToString(" ").lowercase()
    return hay.contains(q.lowercase())
}

/** Actor + target context line built only from real fields. */
private fun rowContext(entry: ActivityLogEntry): String {
    val parts = buildList {
        if (entry.description.isNotBlank()) add(entry.description)
        if (entry.actorId.isNotBlank()) add(entry.actorId)
        val target = when {
            entry.targetCollection.isNotBlank() && entry.targetId.isNotBlank() ->
                "${entry.targetCollection}/${entry.targetId}"
            entry.targetId.isNotBlank() -> entry.targetId
            entry.targetCollection.isNotBlank() -> entry.targetCollection
            else -> ""
        }
        if (target.isNotBlank()) add(target)
    }
    return parts.joinToString(" · ")
}

private fun categoryTone(actionType: String): AuntieStatusTone {
    val a = actionType.uppercase()
    return when {
        a.startsWith("AUTH") || a.contains("LOGIN") || a.contains("LOGOUT") -> AuntieStatusTone.Purple
        a.startsWith("BOOKING") || a.startsWith("KINCARE") ||
            a.contains("SESSION") || a.contains("VISIT")                    -> AuntieStatusTone.Orange
        a.contains("KINTALE") || a.contains("CONTENT") ||
            a.contains("DRAFT") || a.contains("REPORT")                     -> AuntieStatusTone.Success
        a.contains("NOTIFICATION") || a.contains("NOTIF")                   -> AuntieStatusTone.Teal
        a.startsWith("ADMIN") || a.contains("TRIAGE")                       -> AuntieStatusTone.Error
        else                                                                -> AuntieStatusTone.Neutral
    }
}

private fun statusTone(status: String): AuntieStatusTone = when (status.uppercase()) {
    "FAILURE", "ERROR" -> AuntieStatusTone.Error
    "SUCCESS"          -> AuntieStatusTone.Success
    "PENDING"          -> AuntieStatusTone.Warning
    else               -> AuntieStatusTone.Muted
}

private fun actionIcon(actionType: String, status: String): ImageVector {
    if (status.equals("FAILURE", ignoreCase = true) ||
        status.equals("ERROR", ignoreCase = true)
    ) {
        return Lucide.TriangleAlert
    }
    val a = actionType.uppercase()
    return when {
        a.startsWith("AUTH") || a.contains("LOGIN") || a.contains("LOGOUT") -> Lucide.UserCheck
        a.startsWith("UPDATE_SETTINGS") || a.startsWith("SETTINGS")         -> Lucide.Settings2
        a.startsWith("BOOKING") || a.startsWith("KINCARE") ||
            a.contains("SESSION") || a.contains("VISIT")                    -> Lucide.CalendarPlus
        a.contains("KINTALE") || a.contains("CONTENT") ||
            a.contains("DRAFT") || a.contains("REPORT")                     -> Lucide.History
        a.contains("NOTIFICATION") || a.contains("NOTIF")                   -> Lucide.Bell
        a.startsWith("ADMIN") || a.contains("TRIAGE")                       -> Lucide.Flag
        else                                                                -> Lucide.Activity
    }
}

private fun humanizeAction(actionType: String): String =
    actionType.lowercase().replace('_', ' ').replaceFirstChar { it.uppercaseChar() }

/** True when [iso] looks like a parseable ISO-8601 date-time (at least yyyy-MM-dd). */
private fun isParseableTimestamp(iso: String): Boolean = runCatching {
    if (iso.length < 10) return@runCatching false
    iso.substring(0, 4).toInt()
    iso.substring(5, 7).toInt() in 1..12
    iso.substring(8, 10).toInt() in 1..31
    true
}.getOrDefault(false)

/** Mockup-style relative-day label: "Today / May 27", "Yesterday / May 26", else "May 24". */
private fun relativeDayLabel(dateIso: String, todayKey: String, yesterdayKey: String): String {
    val pretty = prettyDate(dateIso)
    return when (dateIso) {
        todayKey     -> "Today · $pretty"
        yesterdayKey -> "Yesterday · $pretty"
        else         -> pretty
    }
}

private fun prettyDate(iso: String): String = runCatching {
    if (iso.length < 10) return@runCatching iso.ifBlank { "Undated" }
    val month = MONTHS[iso.substring(5, 7).toInt() - 1]
    val day = iso.substring(8, 10).trimStart('0').ifBlank { "0" }
    "$month $day"
}.getOrDefault(iso.ifBlank { "Undated" })

private fun shortTime(iso: String): String =
    runCatching { if (iso.length >= 16) formatTime(iso) else iso.ifBlank { "--:--" } }
        .getOrDefault(iso.ifBlank { "--:--" })

/**
 * Decrements an ISO date key (yyyy-MM-dd) by one day for the "Yesterday" label.
 * Returns a non-matching sentinel if [todayKey] is not a parseable date, so we
 * simply never label anything "Yesterday" rather than mislabel.
 */
private fun isoDateMinusOneDay(todayKey: String): String = runCatching {
    if (todayKey.length < 10) return@runCatching ""
    var year = todayKey.substring(0, 4).toInt()
    var month = todayKey.substring(5, 7).toInt()
    var day = todayKey.substring(8, 10).toInt() - 1
    if (day < 1) {
        month -= 1
        if (month < 1) { month = 12; year -= 1 }
        day = daysInMonth(year, month)
    }
    "${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}"
}.getOrDefault("")

private fun daysInMonth(year: Int, month: Int): Int = when (month) {
    1, 3, 5, 7, 8, 10, 12 -> 31
    4, 6, 9, 11           -> 30
    2 -> if ((year % 4 == 0 && year % 100 != 0) || year % 400 == 0) 29 else 28
    else -> 30
}

private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
