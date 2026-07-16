package com.tribetails.auntieos.web.screens.activity

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
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
import com.tribetails.auntieos.web.data.ActivityLogEntry
import com.tribetails.auntieos.web.data.ChainVerifyResult
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.launch
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieChip
import com.tribetails.auntieos.web.ui.components.AuntieChipTone
import com.tribetails.auntieos.web.ui.components.AuntieIconTile
import com.tribetails.auntieos.web.ui.components.AuntieSearchField
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import androidx.compose.foundation.clickable
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.AuntieKeyValueRow
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.EmptyHint
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.util.nowIso

/**
 * Activity log (hash-chain audit trail) in the Den aesthetic. Reads the
 * `activity_log` collection via [FirestoreClient.activityStream] and groups
 * entries by day.
 *
 * Fail-loud honesty (per project policy):
 *  - The cryptographic verification verdict panel and the per-entry seq/entryHash
 *    column are bound to the REAL hash-chain seal. A sealed entry shows its
 *    "#seq · <hash8>"; a legacy entry that predates the chain shows an honest
 *    "unchained" pill. We never fabricate a green pass or fake hashes.
 *  - Load failures surface as a loud Error banner; we never swallow them.
 *  - Timestamp parsing tolerates non-ISO values without silently collapsing every
 *    row into one "Undated" group; if a meaningful share of rows have unparseable
 *    timestamps we raise a visible Warning banner so the writer/reader contract
 *    mismatch is not hidden.
 */

// Client-side safety cap. The web bridge listens to a bare collection query with
// no server-side orderBy/limit (see firebase-bridge.js listenCollection), and an
// append-only audit log grows forever. Until the listener gains a server-side cap
// we render at most this many of the newest entries and raise a visible banner so
// the truncation is never silent. See clientMethodsNeeded for the real fix.
private const val MAX_RENDERED_ENTRIES = 500

// Den filter buckets. Each maps a set of actionType prefixes onto a chip. "All"
// passes everything through. Filtering is purely client-side over the already
// streamed entries, so no new backend call is introduced.
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

private fun ActivityFilter.chipTone(): AuntieChipTone = when (this) {
    ActivityFilter.All           -> AuntieChipTone.Neutral
    ActivityFilter.Auth          -> AuntieChipTone.Purple
    ActivityFilter.Bookings      -> AuntieChipTone.Orange
    ActivityFilter.KinTales      -> AuntieChipTone.Accent
    ActivityFilter.Notifications -> AuntieChipTone.Teal
    ActivityFilter.Admin         -> AuntieChipTone.Orange
}

@Composable
fun ActivityLogScreen() {
    val client = remember { FirestoreClient() }
    // P0-FLICKER: hoist the Flow via remember so it survives recomposition.
    val state by remember { client.activityStream() }.collectAsState(initial = FirestoreResult.Loading)

    var filter by remember { mutableStateOf(ActivityFilter.All) }
    var query by remember { mutableStateOf("") }

    // Live hash-chain integrity: call the verifyActivityLogChain admin callable on
    // load (and on Re-verify). The server walks the SHA-256 chain and returns the
    // real verdict; we never fabricate a pass.
    val scope = rememberCoroutineScope()
    var chain by remember { mutableStateOf<ChainState>(ChainState.Verifying) }
    fun verify() {
        chain = ChainState.Verifying
        scope.launch {
            chain = chainStateFrom(client.verifyActivityLogChain())
        }
    }
    LaunchedEffect(Unit) { verify() }

    // Clicked entry opens a read-only detail overlay (spec 22 item 1).
    var selectedEntry by remember { mutableStateOf<ActivityLogEntry?>(null) }

    ScreenScaffold {
        DenScreenHeading(
            kicker     = "The Den · Activity log",
            title      = "Every move,",
            accentTail = "sealed.",
            subtitle   = "The append-only audit trail. Every login, edit, and system event the app records, sealed into the hash chain.",
        )
        Spacer(Modifier.height(20.dp))

        when (val s = state) {
            FirestoreResult.Loading ->
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    repeat(5) { ShimmerCard(height = 72.dp) }
                }

            is FirestoreResult.Error -> AuntieBanner(
                tone  = AuntieBannerTone.Error,
                title = "Couldn't load the activity log",
                icon  = Lucide.TriangleAlert,
            ) {
                Text(
                    s.message.ifBlank { "The audit-log listener returned an error." },
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim,
                )
            }

            is FirestoreResult.Data -> {
                val all = s.value

                ChainIntegrityPanel(entryCount = all.size, state = chain, onReverify = { verify() })
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
                    all        = all,
                    filter     = filter,
                    query      = query,
                    onRowClick = { selectedEntry = it },
                )
            }
        }
    }

    selectedEntry?.let { entry ->
        ActivityDetailModal(entry = entry, onDismiss = { selectedEntry = null })
    }
}

@Composable
private fun LogPanel(
    all: List<ActivityLogEntry>,
    filter: ActivityFilter,
    query: String,
    onRowClick: (ActivityLogEntry) -> Unit,
) {
    DenPanel(
        title    = "Sealed events",
        subtitle = "Newest first. Grouped by day.",
    ) {
        if (all.isEmpty()) {
            EmptyState()
            return@DenPanel
        }

        // Cap + sort newest-first client-side. The bridge has no server orderBy/limit,
        // so we cap loudly here rather than render an unbounded list silently.
        val truncated = all.size > MAX_RENDERED_ENTRIES
        val sortedAll = all.sortedByDescending { it.timestamp }
        val capped = if (truncated) sortedAll.take(MAX_RENDERED_ENTRIES) else sortedAll

        if (truncated) {
            AuntieBanner(
                tone     = AuntieBannerTone.Warning,
                title    = "Showing the newest $MAX_RENDERED_ENTRIES of ${all.size} entries",
                icon     = Lucide.TriangleAlert,
                dashed   = true,
            ) {
                Text(
                    "The audit-log listener has no server-side ordering or limit yet, so the full collection " +
                        "is downloaded each snapshot. Older entries are hidden here until a paged query is wired.",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim,
                )
            }
            Spacer(Modifier.height(12.dp))
        }

        // Timestamp-contract guard: if a meaningful share of rows have unparseable
        // timestamps, the writer may be storing Firestore Timestamp objects instead
        // of ISO-8601 strings. Surface that loudly rather than collapsing to one
        // "Undated" bucket and pretending the ordering is meaningful.
        val unparseable = capped.count { !isParseableTimestamp(it.timestamp) }
        if (unparseable > 0 && unparseable >= capped.size / 2) {
            AuntieBanner(
                tone   = AuntieBannerTone.Warning,
                title  = "Timestamps look unparseable",
                icon   = Lucide.TriangleAlert,
                dashed = true,
            ) {
                Text(
                    "$unparseable of ${capped.size} entries have a timestamp this screen can't read as ISO-8601. " +
                        "The audit writer may be storing a Firestore Timestamp object instead of a string, " +
                        "which breaks day-grouping and ordering. Day/time shown as best-effort below.",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim,
                )
            }
            Spacer(Modifier.height(12.dp))
        }

        val visible = capped
            .filter { filter.matches(it.actionType) }
            .filter { matchesQuery(it, query) }

        if (visible.isEmpty()) {
            NoMatchesState()
            return@DenPanel
        }

        // Stable insertion-ordered grouping; capped list is already newest-first.
        val todayKey = nowIso().take(10)
        val yesterdayKey = isoDateMinusOneDay(todayKey)
        val grouped = visible.groupBy { it.timestamp.take(10) }

        Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            grouped.forEach { (dateIso, entries) ->
                DaySeparator(
                    label = relativeDayLabel(dateIso, todayKey, yesterdayKey),
                    count = entries.size,
                )
                entries.forEach { entry -> ActivityRow(entry, onClick = { onRowClick(entry) }) }
            }
        }
    }
}

/** UI state for the live hash-chain verification. */
internal sealed interface ChainState {
    object Verifying : ChainState
    data class Done(val r: ChainVerifyResult) : ChainState
    data class Failed(val msg: String) : ChainState
}

/**
 * Maps the `verifyActivityLogChain` callable result onto the [ChainState] the
 * panel renders: an Ok (pass or in-band anomaly) becomes [ChainState.Done] (the
 * panel reads `r.ok` to split VERIFIED vs ANOMALY), an Err becomes a fail-loud
 * [ChainState.Failed] carrying the message. Pure; unit + integration tested so
 * the anomaly/error branches can never silently collapse to a fake pass.
 */
internal fun chainStateFrom(result: WriteResult<ChainVerifyResult>): ChainState =
    when (result) {
        is WriteResult.Ok  -> ChainState.Done(result.value)
        is WriteResult.Err -> ChainState.Failed(result.message)
    }

/**
 * The Den "chain integrity" surface, now backed by the real
 * `verifyActivityLogChain` admin callable. Shows VERIFIED (seq range + sealed
 * count) on a clean pass, the first anomaly code on a break, or a fail-loud
 * error if the verify call itself failed. Never fabricates a pass.
 */
@Composable
internal fun ChainIntegrityPanel(entryCount: Int, state: ChainState, onReverify: () -> Unit) {
    val c = AuntieTheme.colors

    val (pillLabel, pillTone) = when (state) {
        is ChainState.Verifying -> "VERIFYING" to AuntieStatusTone.Muted
        is ChainState.Failed    -> "CHECK FAILED" to AuntieStatusTone.Error
        is ChainState.Done      -> if (state.r.ok) "VERIFIED" to AuntieStatusTone.Success
                                   else "ANOMALY" to AuntieStatusTone.Error
    }
    val tileTone = when {
        state is ChainState.Done && state.r.ok -> AuntieStatusTone.Teal
        state is ChainState.Done || state is ChainState.Failed -> AuntieStatusTone.Error
        else -> AuntieStatusTone.Muted
    }
    val detail = when (state) {
        is ChainState.Verifying -> "Walking the SHA-256 chain..."
        is ChainState.Failed    -> "Verification call failed."
        is ChainState.Done -> when {
            !state.r.ok -> "Chain broke at the first anomaly below."
            state.r.scanned == 0 -> "No chained entries yet."
            else -> buildString {
                append("Chain verified")
                if (state.r.firstSeq != null && state.r.lastSeq != null)
                    append(" · seq ${state.r.firstSeq}..${state.r.lastSeq}")
                append(" · ${state.r.scanned} sealed")
                if (state.r.unchainedCount > 0) append(" · ${state.r.unchainedCount} legacy unchained")
            }
        }
    }

    DenPanel(
        title    = "Hash chain",
        subtitle = "writeAuditEntry seals each event into a SHA-256 chain.",
        trailing = {
            Row(
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                AuntieStatusPill(label = pillLabel, tone = pillTone, mono = true)
                GhostButton(label = "Re-verify", onClick = onReverify, enabled = state !is ChainState.Verifying)
            }
        },
    ) {
        Row(
            verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            AuntieIconTile(icon = Lucide.ShieldCheck, tone = tileTone, size = 36.dp)
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    "$entryCount ${if (entryCount == 1) "entry" else "entries"} loaded",
                    style = AuntieTheme.typography.titleSmall,
                    color = c.textPrimary,
                )
                Text(
                    detail,
                    style = AuntieTheme.typography.mono,
                    color = c.textDim,
                )
            }
        }

        if (state is ChainState.Done && !state.r.ok) {
            Spacer(Modifier.height(12.dp))
            AuntieBanner(
                tone  = AuntieBannerTone.Error,
                title = "Chain anomaly detected",
                icon  = Lucide.TriangleAlert,
            ) {
                Text(
                    "First break: ${state.r.anomalyCode ?: "unknown"} at seq ${state.r.anomalySeq ?: "?"}. " +
                        "expected=${state.r.expectedEntryHash?.take(16) ?: "-"} actual=${state.r.actualEntryHash?.take(16) ?: "-"}. " +
                        "The append-only audit trail may have been written out of band. Investigate before trusting later entries.",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }
        }

        if (state is ChainState.Failed) {
            Spacer(Modifier.height(12.dp))
            AuntieBanner(
                tone  = AuntieBannerTone.Error,
                title = "Could not verify the chain",
                icon  = Lucide.TriangleAlert,
            ) {
                Text(
                    state.msg.ifBlank { "The verifyActivityLogChain call returned an error." },
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }
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
                tone     = f.chipTone(),
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
 * Per-row hash-chain seal label: "#<seq> · <first 8 of entryHash>" when the entry
 * is sealed into the chain, or null when it has no seq (legacy/unchained), so the
 * caller can decide what to render. Never fabricates a hash. Pure; unit-tested.
 */
internal fun seqHashLabel(seq: Int?, entryHash: String): String? {
    if (seq == null) return null
    val short = entryHash.take(8)
    return if (short.isNotBlank()) "#$seq · $short" else "#$seq"
}

@Composable
internal fun ActivityRow(entry: ActivityLogEntry, onClick: () -> Unit) {
    val c = AuntieTheme.colors
    val isFailure = entry.status.equals("FAILURE", ignoreCase = true) ||
        entry.status.equals("ERROR", ignoreCase = true)
    val tone = if (isFailure) AuntieStatusTone.Error else categoryTone(entry.actionType)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 10.dp),
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            text  = shortTime(entry.timestamp),
            style = AuntieTheme.typography.mono,
            color = c.textFaint,
            modifier = Modifier.width(54.dp),
        )

        AuntieIconTile(
            icon = actionIcon(entry.actionType, entry.status),
            tone = tone,
            size = 30.dp,
        )

        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Text(
                    text  = humanizeAction(entry.actionType),
                    style = AuntieTheme.typography.titleSmall,
                    color = c.textPrimary,
                )
                if (entry.actionType.isNotBlank()) {
                    Text(
                        text  = entry.actionType.uppercase(),
                        style = AuntieTheme.typography.mono,
                        color = c.textFaint,
                    )
                }
                if (entry.status.isNotBlank()) {
                    AuntieStatusPill(
                        label = entry.status,
                        tone  = statusTone(entry.status),
                        mono  = true,
                    )
                }
            }
            val context = rowContext(entry)
            if (context.isNotBlank()) {
                Text(
                    text     = context,
                    style    = AuntieTheme.typography.bodySmall,
                    color    = c.textDim,
                    maxLines = 2,
                )
            }
        }

        // Per-row seq + entryHash column (Den mockup right rail). Bound to the REAL
        // hash-chain seal: a sealed entry shows "#seq · <hash8>"; a legacy entry that
        // predates the chain shows the honest "unchained" pill.
        val sealLabel = seqHashLabel(entry.seq, entry.entryHash)
        if (sealLabel != null) {
            AuntieStatusPill(label = sealLabel, tone = AuntieStatusTone.Teal, mono = true)
        } else {
            AuntieStatusPill(label = "unchained", tone = AuntieStatusTone.Muted, mono = true)
        }
    }
}

/**
 * Read-only detail overlay for a clicked activity entry (spec 22 item 1). Surfaces
 * the FULL record the row truncates: full timestamp, action, status, actor,
 * description, and the target doc as a `collection/id` path. All fields are already
 * on the model; no fabricated data, no dead deep-link.
 */
@Composable
private fun ActivityDetailModal(entry: ActivityLogEntry, onDismiss: () -> Unit) {
    val target = listOf(entry.targetCollection, entry.targetId).filter { it.isNotBlank() }.joinToString("/")
    AuntieDialog(
        visible = true,
        title = humanizeAction(entry.actionType),
        onDismiss = onDismiss,
        hint = entry.actionType.uppercase().ifBlank { null },
        maxWidth = 460.dp,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            AuntieKeyValueRow(label = "When", value = entry.timestamp.ifBlank { "-" }, valueMono = true)
            AuntieKeyValueRow(label = "Action", value = entry.actionType.ifBlank { "-" }, valueMono = true)
            AuntieKeyValueRow(label = "Status", value = entry.status.ifBlank { "-" })
            AuntieKeyValueRow(label = "Actor", value = entry.actorId.ifBlank { "-" }, valueMono = true)
            if (entry.description.isNotBlank()) {
                AuntieKeyValueRow(label = "Detail", value = entry.description)
            }
            AuntieKeyValueRow(label = "Target", value = target.ifBlank { "-" }, valueMono = true, showDivider = false)
        }
    }
}

@Composable
private fun EmptyState() {
    val c = AuntieTheme.colors
    Column(
        modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally,
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
        horizontalAlignment = androidx.compose.ui.Alignment.CenterHorizontally,
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
    runCatching { if (iso.length >= 16) iso.substring(11, 16) else iso.ifBlank { "--:--" } }
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
