package com.tribetails.auntieos.web.screens.activity

import com.tribetails.auntieos.web.screens.unreadableTimesNote
import com.tribetails.auntieos.web.screens.media.rememberStaffRoster
import com.tribetails.auntieos.web.data.staffRolesFrom
import com.tribetails.auntieos.web.data.uploaderNamesFrom
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
import com.tribetails.auntieos.web.observability.rememberReportingScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Activity
import com.composables.icons.lucide.Bell
import com.composables.icons.lucide.CalendarPlus
import com.composables.icons.lucide.Eye
import com.composables.icons.lucide.Flag
import com.composables.icons.lucide.History
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Receipt
import com.composables.icons.lucide.Settings2
import com.composables.icons.lucide.ShieldCheck
import com.composables.icons.lucide.TriangleAlert
import com.composables.icons.lucide.UserCheck
import com.tribetails.auntieos.web.data.ActivityLogEntry
import com.tribetails.auntieos.web.data.activityDescriptionWords
import com.tribetails.auntieos.web.data.activityTitleWords
import com.tribetails.auntieos.web.data.brandWords
import com.tribetails.auntieos.web.data.ChainVerifyResult
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.observability.runCatchingCancellable
import kotlinx.coroutines.launch
import kotlinx.datetime.TimeZone
import com.tribetails.auntieos.web.screens.booking.NewBookingMath
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
import com.tribetails.auntieos.web.util.businessTodayIso

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

// Client-side render cap. The stream reads the whole collection, and an
// append-only audit log grows forever, so the list draws the newest
// [MAX_RENDERED_ENTRIES] first. #1880: "Load older entries" draws the next
// [OLDER_PAGE] each press, so every entry can be reached.
internal const val MAX_RENDERED_ENTRIES = 500
internal const val OLDER_PAGE = 200
internal const val LOAD_OLDER_LABEL = "Load older entries"
/** #1880: how many entries the list draws after [presses] presses of "Load older entries". */
internal fun renderedEntryCount(total: Int, presses: Int): Int =
    minOf(total, MAX_RENDERED_ENTRIES + presses * OLDER_PAGE)

// Den filter buckets. Each maps a set of actionType prefixes onto a chip. "All"
// passes everything through. Filtering is purely client-side over the already
// streamed entries, so no new backend call is introduced.
private enum class ActivityFilter(val label: String) {
    All("All"),
    Auth("Auth"),
    Bookings("Bookings"),
    KinTales("KinTales"),
    Notifications("Notifications"),
    Billing("Billing"),
    Admin("Admin"),
}

private fun ActivityFilter.matches(actionType: String): Boolean {
    if (this == ActivityFilter.All) return true
    return activityCategoryOf(actionType)?.name == name
}

private fun ActivityFilter.chipTone(): AuntieChipTone = when (this) {
    ActivityFilter.All           -> AuntieChipTone.Neutral
    ActivityFilter.Auth          -> AuntieChipTone.Purple
    ActivityFilter.Bookings      -> AuntieChipTone.Orange
    ActivityFilter.KinTales      -> AuntieChipTone.Accent
    ActivityFilter.Notifications -> AuntieChipTone.Teal
    ActivityFilter.Billing       -> AuntieChipTone.Orange
    ActivityFilter.Admin         -> AuntieChipTone.Orange
}

@Composable
fun ActivityLogScreen() {
    val client = remember { FirestoreClient() }
    // The staff roster, read once. #1592 takes each actor's name from it (#1564's
    // fallback); #1820 takes whether they are the owner or an Auntie.
    val staff = rememberStaffRoster(client)
    val staffNames = remember(staff) { uploaderNamesFrom(staff) }
    val staffRoles = remember(staff) { staffRolesFrom(staff) }
    // #1818: the household by name on an opened entry, never its id.
    val kinfolkState by remember { client.kinfolkStream() }.collectAsState(initial = FirestoreResult.Loading)
    val households = remember(kinfolkState) {
        householdNamesById((kinfolkState as? FirestoreResult.Data)?.value.orEmpty())
    }
    // P0-FLICKER: hoist the Flow via remember so it survives recomposition.
    val state by remember { client.activityStream() }.collectAsState(initial = FirestoreResult.Loading)

    var filter by remember { mutableStateOf(ActivityFilter.All) }
    var query by remember { mutableStateOf("") }
    // The business's clock (#1585): America/Chicago until the settings read lands or if it fails.
    val settingsState by remember { client.businessSettingsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val zone = remember(settingsState) {
        NewBookingMath.businessTimeZone((settingsState as? FirestoreResult.Data)?.value?.timeZone)
    }

    // Live hash-chain integrity: call the verifyActivityLogChain admin callable on
    // load (and on Re-verify). The server walks the SHA-256 chain and returns the
    // real verdict; we never fabricate a pass.
    val scope = rememberReportingScope()
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
                    placeholder   = "Search activity",
                    leadingIcon   = Lucide.Activity,
                    onClear       = { query = "" },
                    modifier      = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(16.dp))

                LogPanel(
                    all        = all,
                    filter     = filter,
                    query      = query,
                    zone       = zone,
                    onRowClick = { selectedEntry = it },
                    staffNames = staffNames,
                    staffRoles = staffRoles,
                )
            }
        }
    }

    selectedEntry?.let { entry ->
        ActivityDetailModal(
            entry = entry,
            zone = zone,
            onDismiss = { selectedEntry = null },
            names = staffNames,
            roles = staffRoles,
            households = households,
        )
    }
}

@Composable
private fun LogPanel(
    all: List<ActivityLogEntry>,
    filter: ActivityFilter,
    query: String,
    zone: TimeZone,
    onRowClick: (ActivityLogEntry) -> Unit,
    staffNames: Map<String, String> = emptyMap(),
    staffRoles: Map<String, String> = emptyMap(),
) {
    // #1880: how many times "Load older entries" was pressed on this screen.
    var olderPresses by remember { mutableStateOf(0) }
    DenPanel(
        title    = "Sealed events",
        subtitle = "Newest first. Grouped by day.",
    ) {
        if (all.isEmpty()) {
            EmptyState()
            return@DenPanel
        }

        // Sort newest-first, then draw the newest [renderedEntryCount] (#1880).
        val sortedAll = all.sortedByDescending { it.timestamp }
        val shown = renderedEntryCount(sortedAll.size, olderPresses)
        val truncated = shown < sortedAll.size
        val capped = sortedAll.take(shown)
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
                    unreadableTimesNote(unparseable, capped.size),
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim,
                )
            }
            Spacer(Modifier.height(12.dp))
        }

        val visible = capped
            .filter { filter.matches(it.actionType) }
            .filter { matchesQuery(it, query, staffNames) }

        if (visible.isEmpty()) {
            NoMatchesState()
            // #1880: an older entry may still match, so the way to it stays.
            if (truncated) GhostButton(label = LOAD_OLDER_LABEL, onClick = { olderPresses += 1 })
            return@DenPanel
        }

        // Stable insertion-ordered grouping; capped list is already newest-first.
        // Days are the BUSINESS's (#1585): a 9:34 pm Chicago event stamped 02:34Z belongs
        // to the day before, and "Today" is Chicago's today.
        val todayKey = activityWhen(nowIso(), zone)?.dayKey ?: businessTodayIso()
        val yesterdayKey = isoDateMinusOneDay(todayKey)
        val grouped = visible.groupBy { activityWhen(it.timestamp, zone)?.dayKey ?: it.timestamp.take(10) }

        Column(modifier = Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            grouped.forEach { (dateIso, entries) ->
                DaySeparator(
                    label = relativeDayLabel(dateIso, todayKey, yesterdayKey),
                    count = entries.size,
                )
                entries.forEach { entry -> ActivityRow(entry, zone = zone, names = staffNames, roles = staffRoles, onClick = { onRowClick(entry) }) }
            }
        }
        if (truncated) {
            Spacer(Modifier.height(12.dp))
            GhostButton(label = LOAD_OLDER_LABEL, onClick = { olderPresses += 1 })
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
        subtitle = "Each event is sealed into a SHA-256 chain.",
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
internal fun ActivityRow(
    entry: ActivityLogEntry,
    onClick: () -> Unit,
    zone: TimeZone = NewBookingMath.businessTimeZone(null),
    names: Map<String, String> = emptyMap(),
    roles: Map<String, String> = emptyMap(),
) {
    val c = AuntieTheme.colors
    val tone = rowTone(entry.actionType, entry.status)

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 10.dp),
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            text  = shortTime(entry.timestamp, zone),
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
                    text  = activityEntryTitle(entry),
                    style = AuntieTheme.typography.titleSmall,
                    color = c.textPrimary,
                )
                // #1818: no stored key beside the title. The title says it in words.
                if (entry.status.isNotBlank()) {
                    AuntieStatusPill(
                        // #1819: "Not sent" on a notice that did not go out, never SUCCESS.
                        label = activityStatusWords(entry),
                        tone  = statusTone(activityEffectiveStatus(entry)),
                        mono  = true,
                    )
                }
            }
            val context = rowContext(entry, names, roles)
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
 * Read-only detail overlay for a clicked activity entry (spec 22 item 1).
 *
 * #1818: in words. It used to list the stored key, the actor's uid, the raw
 * UTC stamp beside the business time, and the target's database path. Now it
 * is one readable time, the person and the household by name, and the status
 * in words. The ids stay on the sealed entry, and search still finds them.
 */
@Composable
private fun ActivityDetailModal(
    entry: ActivityLogEntry,
    zone: TimeZone,
    onDismiss: () -> Unit,
    names: Map<String, String> = emptyMap(),
    /** uid -> "owner" | "auntie" (listStaff), #1820. See [actorRoleFor]. */
    roles: Map<String, String> = emptyMap(),
    /** household id -> name, #1818. */
    households: Map<String, String> = emptyMap(),
) {
    val rows = activityDetailRows(entry, zone, names, roles, households)
    AuntieDialog(
        visible = true,
        title = activityEntryTitle(entry),
        onDismiss = onDismiss,
        maxWidth = 460.dp,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            rows.forEachIndexed { i, (label, value) ->
                AuntieKeyValueRow(label = label, value = value, showDivider = i < rows.lastIndex)
            }
        }
    }
}

/**
 * The opened entry's rows, in words (#1818), blanks dropped. Same order and
 * rules as the web (`activityDetailRows` in `lib/activityDetail.ts`) and Android.
 */
internal fun activityDetailRows(
    entry: ActivityLogEntry,
    zone: TimeZone = NewBookingMath.businessTimeZone(null),
    names: Map<String, String> = emptyMap(),
    roles: Map<String, String> = emptyMap(),
    households: Map<String, String> = emptyMap(),
): List<Pair<String, String>> {
    val rows = mutableListOf<Pair<String, String>>()
    fun add(label: String, value: String) {
        if (value.isNotBlank()) rows += label to value.trim()
    }
    add("When", activityWhen(entry.timestamp, zone)?.let(::activityWhenWords).orEmpty())
    add("Status", activityStatusWords(entry))
    add("Actor", activityActorName(entry, names))
    add("Actor role", actorRoleFor(entry, roles))
    add("Household", households[entry.familyId.trim()].orEmpty())
    // #1747: a stored path reads as words; the entry is never rewritten.
    add("Detail", activityEntryDescription(entry))
    return rows
}

/** `Nov 11, 2026, 11:33a`: an entry's time as the opened entry reads it (#1818). */
internal fun activityWhenWords(w: ActivityWhen): String {
    val month = MONTHS.getOrNull(w.dayKey.substring(5, 7).toInt() - 1) ?: w.dayKey.substring(5, 7)
    val day = w.dayKey.substring(8, 10).toInt()
    return "$month $day, ${w.dayKey.take(4)}, ${w.clock}"
}

/** Household id to name, real names only (#1818). */
internal fun householdNamesById(directory: List<Kinfolk>): Map<String, String> =
    directory
        .filter { it.firstName.isNotBlank() || it.lastName.isNotBlank() }
        .associate { it._id to "${it.firstName} ${it.lastName}".trim() }

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

internal fun matchesQuery(entry: ActivityLogEntry, query: String, names: Map<String, String> = emptyMap()): Boolean {
    val q = query.trim()
    if (q.isBlank()) return true
    val hay = listOf(
        entry.actionType,
        activityTitle(entry.actionType),
        entry.description,
        activityDescriptionWords(entry.description),
        // #1819: a held notice's title, sentence and status, as the row shows them.
        activityEntryTitle(entry),
        activityEntryDescription(entry),
        activityStatusWords(entry),
        entry.actorId,
        names[entry.actorId.trim()].orEmpty(),
        entry.targetId,
        entry.targetCollection,
        entry.status,
        entry.familyId,
        // #1818: the ids the screen no longer shows still find their row.
        entry.payload?.toString().orEmpty(),
    ).joinToString(" ").lowercase()
    return hay.contains(q.lowercase())
}

/**
 * The collapsed row's grey line (#1818): the sentence, then who did it. No
 * database path, no id, no email. A sentence that only repeats the title is
 * left off; a stored "<KEY> uid=<id>" reads as nothing for the same reason.
 */
internal fun rowContext(
    entry: ActivityLogEntry,
    names: Map<String, String> = emptyMap(),
    roles: Map<String, String> = emptyMap(),
): String {
    val parts = mutableListOf<String>()
    val words = activityEntryDescription(entry).trim()
    val title = activityEntryTitle(entry).trim()
    if (words.isNotEmpty() && !words.equals(title, ignoreCase = true)) parts += words
    if (isHouseholdLook(entry.actionType)) {
        // #1839: a look the server wrote in words already names the Auntie and
        // the household. A look stored as the bare key keeps the name.
        val namedInWords = words.isNotEmpty() && words == entry.description.trim()
        val who = if (namedInWords) "" else activityActorName(entry, names)
        if (who.isNotEmpty()) parts += who
        return parts.joinToString(" · ")
    }
    val who = activityActorWords(entry, names, roles)
    if (who.isNotEmpty()) parts += who
    return parts.joinToString(" · ")
}

/**
 * #1818: the actor's name, or nothing. The roster's label falls back to a
 * sign-in email and then the uid, and neither belongs on screen.
 */
internal fun activityActorName(entry: ActivityLogEntry, names: Map<String, String>): String {
    val actor = entry.actorId.trim()
    if (actor.isEmpty()) return ""
    val name = names[actor].orEmpty().trim()
    return if (name.isEmpty() || name == actor || '@' in name) "" else name
}

/** #1818: the person's name, or the role they held when the roster has no name for them. Never an id. */
internal fun activityActorWords(
    entry: ActivityLogEntry,
    names: Map<String, String>,
    roles: Map<String, String> = emptyMap(),
): String {
    val name = activityActorName(entry, names)
    if (name.isNotEmpty()) return name
    if (entry.actorId.isBlank() && entry.actorRole.isBlank()) return ""
    return actorRoleFor(entry, roles)
}

/**
 * The row tile's tone. A failure is the error tone whatever its kind; a look at
 * a household (#1839) is routine, so it files under Admin for the filter but
 * never wears that chip's red; everything else takes its category's tone.
 */
internal fun rowTone(actionType: String, status: String): AuntieStatusTone = when {
    status.equals("FAILURE", ignoreCase = true) || status.equals("ERROR", ignoreCase = true) -> AuntieStatusTone.Error
    isHouseholdLook(actionType) -> AuntieStatusTone.Neutral
    else -> categoryTone(actionType)
}

private fun categoryTone(actionType: String): AuntieStatusTone = when (activityCategoryOf(actionType)) {
    ActivityCategory.Auth          -> AuntieStatusTone.Purple
    ActivityCategory.Bookings      -> AuntieStatusTone.Orange
    ActivityCategory.KinTales      -> AuntieStatusTone.Success
    ActivityCategory.Notifications -> AuntieStatusTone.Teal
    ActivityCategory.Billing       -> AuntieStatusTone.Warning
    ActivityCategory.Admin         -> AuntieStatusTone.Error
    null                           -> AuntieStatusTone.Neutral
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
    if (isHouseholdLook(actionType)) return Lucide.Eye
    val a = actionType.uppercase()
    return when (activityCategoryOf(actionType)) {
        ActivityCategory.Auth          -> Lucide.UserCheck
        ActivityCategory.Bookings      -> Lucide.CalendarPlus
        ActivityCategory.KinTales      -> Lucide.History
        ActivityCategory.Notifications -> Lucide.Bell
        ActivityCategory.Billing       -> Lucide.Receipt
        ActivityCategory.Admin         -> if (a.startsWith("UPDATE_SETTINGS") || a.startsWith("SETTINGS")) Lucide.Settings2 else Lucide.Flag
        null                           -> Lucide.Activity
    }
}

/** `KINCARE_ARRIVED` reads "KinCare arrived": brand words in their casing (#1881). */
internal fun humanizeAction(actionType: String): String = brandWords(actionType).ifEmpty { "Event" }

/**
 * #1839: the stored key of a look at a household. Since operator ruling
 * 2026-11-12 only an Auntie's looks write it; rows stored before then carry the
 * owner's looks too. A routine look, never a warning. Same rule as the web
 * (`activityTitle` in `lib/activityDetail.ts`) and Android.
 */
internal const val HOUSEHOLD_LOOK_ACTION = "OPERATOR_CROSSTENANT_ACCESS"
internal const val HOUSEHOLD_LOOK_TITLE = "Household opened"

internal fun isHouseholdLook(actionType: String): Boolean = actionType.trim().uppercase() == HOUSEHOLD_LOOK_ACTION

/**
 * The row's bold line: the kind's plain title, or its key in words (#1818,
 * #1881). The stored key itself is never on screen. Same rule as the web and
 * Android.
 */
internal fun activityTitle(actionType: String): String = activityTitleWords(actionType)

/** True when [iso] looks like a parseable ISO-8601 date-time (at least yyyy-MM-dd). */
private fun isParseableTimestamp(iso: String): Boolean = runCatchingCancellable {
    if (iso.length < 10) return@runCatchingCancellable false
    iso.substring(0, 4).toInt()
    iso.substring(5, 7).toInt() in 1..12
    iso.substring(8, 10).toInt() in 1..31
    true
}.getOrDefault(false)

/** Mockup-style relative-day label: "Today / May 27", "Yesterday / May 26", else "May 24". */
internal fun relativeDayLabel(dateIso: String, todayKey: String, yesterdayKey: String): String {
    val pretty = prettyDate(dateIso)
    return when (dateIso) {
        todayKey     -> "Today · $pretty"
        yesterdayKey -> "Yesterday · $pretty"
        // #1599: a day from another year says which, the log spans more than one.
        else         -> if (dateIso.take(4) == todayKey.take(4)) pretty else "$pretty, ${dateIso.take(4)}"
    }
}

private fun prettyDate(iso: String): String = runCatchingCancellable {
    if (iso.length < 10) return@runCatchingCancellable iso.ifBlank { "Undated" }
    val month = MONTHS[iso.substring(5, 7).toInt() - 1]
    val day = iso.substring(8, 10).trimStart('0').ifBlank { "0" }
    "$month $day"
}.getOrDefault(iso.ifBlank { "Undated" })

private fun shortTime(iso: String, zone: TimeZone): String =
    activityWhen(iso, zone)?.clock ?: iso.ifBlank { "--:--" }

/**
 * Decrements an ISO date key (yyyy-MM-dd) by one day for the "Yesterday" label.
 * Returns a non-matching sentinel if [todayKey] is not a parseable date, so we
 * simply never label anything "Yesterday" rather than mislabel.
 */
private fun isoDateMinusOneDay(todayKey: String): String = runCatchingCancellable {
    if (todayKey.length < 10) return@runCatchingCancellable ""
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
