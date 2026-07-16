package com.tribetails.auntieos.web.screens.booking

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import com.tribetails.auntieos.web.observability.rememberReportingScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import kotlin.time.Clock
import kotlin.time.ExperimentalTime
import kotlin.time.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlinx.datetime.todayIn
import com.composables.icons.lucide.Ban
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Plus
import com.tribetails.auntieos.web.data.AuntieDataSource
import com.tribetails.auntieos.web.data.CloudFormSchemaRepository
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.FormSchema
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.screens.schedule.BookingDetailModal
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.appliesToSchemaIds
import com.tribetails.auntieos.web.data.resolveTimeBlock
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieAvatar
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieCheckbox
import com.tribetails.auntieos.web.ui.components.AuntieChipGroup
import com.tribetails.auntieos.web.ui.components.AuntieDatePickerDialog
import com.tribetails.auntieos.web.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.DynamicFormFields
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.EmptyHint
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.GlassSurface
import com.tribetails.auntieos.web.ui.components.MultilineField
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.ui.components.color
import kotlinx.coroutines.launch

private sealed interface BookingRoute {
    data object List   : BookingRoute
    data object Create : BookingRoute
}

/**
 * Entry point. Uses the real FirestoreClient-backed data source.
 * Screens that need a test double pass [dataSource] directly.
 */
@Composable
fun BookingScreen() {
    val client = remember { FirestoreClient() }
    BookingScreenContent(dataSource = FirestoreClientBookingDataSource(client), client = client)
}

@Composable
internal fun BookingScreenContent(
    dataSource: AuntieDataSource,
    client: FirestoreClient? = null,
) {
    val vm = remember { BookingViewModel(dataSource) }
    var route by remember { mutableStateOf<BookingRoute>(BookingRoute.List) }

    when (route) {
        BookingRoute.List   -> BookingListScreen(
            vm           = vm,
            client       = client,
            onNewBooking = { route = BookingRoute.Create },
        )
        BookingRoute.Create -> BookingCreateScreen(
            vm     = vm,
            onBack = { route = BookingRoute.List },
        )
    }
}

@Composable
private fun BookingListScreen(
    vm: BookingViewModel,
    client: FirestoreClient?,
    onNewBooking: () -> Unit,
) {
    val c     = AuntieTheme.colors
    val scope = rememberReportingScope()

    // History + Scheduled lifecycle come from the whole kin_care_sessions store
    // (this stays mapped through the VM so the VM test contract is unchanged).
    val sessionsState by remember(vm) { vm.bookingsStream() }.collectAsState(initial = FirestoreResult.Loading)

    // Pending approval reads the REAL requested-bookings source: the server-side
    // status=="DRAFT" query (bookingRequestsStream), NOT the full collection that
    // is dominated by legacy COMPLETED visit imports. When no client is injected
    // (unit-test path) this falls back to an empty Loading flow.
    val pendingState by remember(client) {
        client?.bookingRequestsStream() ?: emptyLoadingFlow()
    }.collectAsState(initial = FirestoreResult.Loading)

    // Bulk multi-select: a select-mode toggle + the chosen visit ids. The bulk
    // action targets the batchUpdateBookings callable, which resolves ids via
    // collectionGroup('kinCares'); the originating kinCare visit id is carried on
    // KinCareSession.sourceBookingId (fall back to _id for direct sessions).
    var selecting by remember { mutableStateOf(false) }
    val selectedIds = remember { mutableStateMapOf<String, Boolean>() }
    var bulkBusy by remember { mutableStateOf(false) }
    var bulkNotice by remember { mutableStateOf<String?>(null) }
    // B2: tap a Pending/Scheduled/History card to open its detail modal (the modal
    // already existed but was wired to nothing). Lifted here so one modal serves all
    // three sections; rendered only when a real client is injected (not in fakes).
    var selectedBooking by remember { mutableStateOf<KinCareSession?>(null) }

    fun batchVisitId(b: KinCareSession): String = b.sourceBookingId.ifBlank { b._id }
    fun toggleSelect(b: KinCareSession) {
        val id = batchVisitId(b)
        if (selectedIds[id] == true) selectedIds.remove(id) else selectedIds[id] = true
    }
    fun clearSelection() = selectedIds.clear()

    fun runBulk(action: String) {
        val ids = selectedIds.filterValues { it }.keys.toList()
        if (ids.isEmpty() || client == null) return
        bulkBusy = true
        scope.launch {
            when (val r = client.batchUpdateBookings(ids, action)) {
                is WriteResult.Err -> { vm.setError("Bulk $action failed: ${r.message}"); bulkNotice = null }
                is WriteResult.Ok  -> {
                    vm.setError(if (r.value.failedCount > 0)
                        "Bulk $action: ${r.value.failedCount} of ${ids.size} could not be updated."
                    else null)
                    bulkNotice = "$action applied: ${com.tribetails.auntieos.web.data.summarizeBatchResult(r.value)}."
                    clearSelection()
                }
            }
            bulkBusy = false
        }
    }

    // Time-block descriptor for booking cards (spec 15 item 5). The resolver +
    // Business-Settings timeBlocks now exist (Stage 1 §A.8), so the service line can
    // carry a real block label. Gated by the same flag as Auntie Time's block pills;
    // returns null (no segment shown) when off or unresolved, never a faked block.
    val settingsState by remember(client) {
        client?.businessSettingsStream() ?: emptyLoadingFlow()
    }.collectAsState(initial = FirestoreResult.Loading)
    val timeBlocks = remember(settingsState) {
        (settingsState as? FirestoreResult.Data)?.value?.timeBlocks.orEmpty()
    }
    val timeBlockLabelFor: (KinCareSession) -> String? = { b ->
        resolveTimeBlock(b.startTime, timeBlocks)?.label
    }

    // 16.5: incoming MyTribe booking-envelope requests, grouped into series. The
    // kinfolk directory supplies the display name the child kinCare docs lack.
    val incomingState by remember(vm) { vm.incomingKinCaresStream() }.collectAsState(initial = FirestoreResult.Loading)
    val incomingKinfolkState by remember(vm) { vm.kinfolkStream() }.collectAsState(initial = FirestoreResult.Loading)
    val incomingSeries = remember(incomingState, incomingKinfolkState) {
        val visits = (incomingState as? FirestoreResult.Data)?.value.orEmpty()
        val names = (incomingKinfolkState as? FirestoreResult.Data)?.value.orEmpty().associate { it._id to it.displayName }
        groupIncomingBySeries(visits) { names[it] }
    }

    ScreenScaffold {
        DenScreenHeading(
            kicker     = "The Den · Bookings",
            title      = "Bookings",
            subtitle   = "Pending requests and scheduled visits.",
            trailing   = {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    GhostButton(
                        label   = if (selecting) "Done" else "Select",
                        onClick = {
                            selecting = !selecting
                            if (!selecting) clearSelection()
                        },
                    )
                    PrimaryButton(
                        label   = "New booking",
                        onClick = onNewBooking,
                        leading = { Icon(Lucide.Plus, contentDescription = null, modifier = Modifier.size(15.dp)) },
                    )
                }
            },
        )
        Spacer(Modifier.height(20.dp))

        // Surface any write error (approve/reject/create) as a persistent banner,
        // never a swallowed toast.
        vm.errorMessage?.let { msg ->
            AuntieBanner(
                tone     = AuntieBannerTone.Error,
                title    = "Something went wrong",
                icon     = Lucide.Ban,
                onDismiss = { vm.clearError() },
            ) { Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim) }
            Spacer(Modifier.height(16.dp))
        }

        bulkNotice?.let { msg ->
            AuntieBanner(
                tone      = AuntieBannerTone.Success,
                title     = "Bulk action done",
                icon      = Lucide.Plus,
                onDismiss = { bulkNotice = null },
            ) { Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim) }
            Spacer(Modifier.height(16.dp))
        }

        // Bulk action bar: visible in select-mode. Applies ONE transition to all
        // selected bookings via batchUpdateBookings (real, fail-loud counts).
        if (selecting) {
            val selectedCount = selectedIds.count { it.value }
            GlassSurface(cornerRadius = 16.dp, modifier = Modifier.fillMaxWidth()) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(
                        text  = if (selectedCount == 0) "Select bookings to act on"
                                else "$selectedCount selected",
                        style = AuntieTheme.typography.titleSmall,
                        color = c.textPrimary,
                        modifier = Modifier.weight(1f),
                    )
                    PrimaryButton(
                        label   = if (bulkBusy) "Working..." else "Approve",
                        onClick = { if (!bulkBusy) runBulk("APPROVE") },
                    )
                    GhostButton(
                        label   = "Reject",
                        onClick = { if (!bulkBusy) runBulk("REJECT") },
                    )
                    GhostButton(
                        label   = "Cancel",
                        onClick = { if (!bulkBusy) runBulk("CANCEL") },
                    )
                }
            }
            Spacer(Modifier.height(16.dp))
        }

        // ── stat row: counts mirror the three sections ────────────────────────
        val pending   = (pendingState as? FirestoreResult.Data)?.value.orEmpty()
        val sessions  = (sessionsState as? FirestoreResult.Data)?.value.orEmpty()
        val scheduled = sessions.filter { it.status.uppercase() == "SCHEDULED" }
        val history   = sessions.filter { it.status.uppercase() !in setOf("SCHEDULED", "DRAFT", "PENDING") }

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            StatRowCard(
                label = "Pending approval",
                value = if (pendingState is FirestoreResult.Loading) "…" else pending.size.toString(),
                trend = "awaiting a reply",
                tone  = AuntieStatusTone.Orange,
                feature = true,
                modifier = Modifier.weight(1f),
            )
            StatRowCard(
                label = "Scheduled",
                value = if (sessionsState is FirestoreResult.Loading) "…" else scheduled.size.toString(),
                trend = "on the books",
                tone  = AuntieStatusTone.Teal,
                modifier = Modifier.weight(1f),
            )
            StatRowCard(
                label = "History",
                value = if (sessionsState is FirestoreResult.Loading) "…" else history.size.toString(),
                trend = "completed and cancelled",
                tone  = AuntieStatusTone.Purple,
                modifier = Modifier.weight(1f),
            )
        }
        Spacer(Modifier.height(20.dp))

        // ── 16.5 Incoming requests (MyTribe envelopes; approve/cancel a series) ──
        if (incomingSeries.isNotEmpty() || incomingState is FirestoreResult.Error) {
            DenPanel(
                title    = "Incoming requests",
                subtitle = "New requests from MyTribe. Approve a whole series at once; approving creates the visits.",
                trailing = { SectionCount("${incomingSeries.size}") },
            ) {
                when {
                    incomingState is FirestoreResult.Error ->
                        EmptyHint("Couldn't load incoming requests: ${(incomingState as FirestoreResult.Error).message}", error = true)
                    else -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        incomingSeries.forEach { series ->
                            IncomingSeriesCard(
                                series = series,
                                busy = vm.seriesActionBatchId == series.batchId,
                                locked = vm.seriesActionBatchId != null,
                                onApprove = { scope.launch { vm.approveSeries(series.kinfolkId, series.batchId) } },
                                onCancel  = { scope.launch { vm.cancelSeries(series.kinfolkId, series.batchId) } },
                            )
                        }
                    }
                }
            }
            Spacer(Modifier.height(18.dp))
        }

        // ── Pending approval (real DRAFT requests) ────────────────────────────
        DenPanel(
            title    = "Pending approval",
            subtitle = "New booking requests waiting on your call.",
            trailing = { SectionCount(if (pendingState is FirestoreResult.Loading) "" else "${pending.size}") },
        ) {
            when {
                pendingState is FirestoreResult.Loading ->
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) { repeat(2) { ShimmerCard(height = 92.dp) } }
                pendingState is FirestoreResult.Error ->
                    EmptyHint("Couldn't load booking requests: ${(pendingState as FirestoreResult.Error).message}", error = true)
                pending.isEmpty() ->
                    EmptyHint("No requests waiting. New bookings land here for approval.")
                else -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    pending.forEach { booking ->
                        BookingCard(
                            booking   = booking,
                            selecting = selecting,
                            selected  = selectedIds[batchVisitId(booking)] == true,
                            onToggleSelect = { toggleSelect(booking) },
                            onApprove = { scope.launch { vm.approveBooking(booking._id) } },
                            onReject  = { scope.launch { vm.rejectBooking(booking._id) } },
                            onCancel  = null,
                            onOpenDetail = { selectedBooking = booking },
                            timeBlockLabel = timeBlockLabelFor(booking),
                        )
                    }
                }
            }
        }
        Spacer(Modifier.height(18.dp))

        // ── Scheduled ─────────────────────────────────────────────────────────
        DenPanel(
            title    = "Scheduled",
            subtitle = "Approved visits on the calendar.",
            trailing = { SectionCount(if (sessionsState is FirestoreResult.Loading) "" else "${scheduled.size}") },
        ) {
            when {
                sessionsState is FirestoreResult.Loading ->
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) { repeat(2) { ShimmerCard(height = 92.dp) } }
                sessionsState is FirestoreResult.Error ->
                    EmptyHint("Couldn't load visits: ${(sessionsState as FirestoreResult.Error).message}", error = true)
                scheduled.isEmpty() ->
                    EmptyHint("Nothing scheduled. Approved requests appear here.")
                else -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    scheduled.forEach { booking ->
                        BookingCard(
                            booking   = booking,
                            selecting = selecting,
                            selected  = selectedIds[batchVisitId(booking)] == true,
                            onToggleSelect = { toggleSelect(booking) },
                            onApprove = null,
                            onReject  = null,
                            onCancel  = { scope.launch { vm.rejectBooking(booking._id) } },
                            onOpenDetail = { selectedBooking = booking },
                            timeBlockLabel = timeBlockLabelFor(booking),
                        )
                    }
                }
            }
        }
        Spacer(Modifier.height(18.dp))

        // ── History (organized: sorted desc, split Completed / Cancelled, capped) ──
        // Auntie's complaint was "raw rows". Sort by the real timestamp each row
        // carries, split by outcome, and cap each subsection (Show more) so the full
        // legacy import never renders at once. The trailing count is the real size,
        // not a literal "recent".
        val buckets = bookingHistoryBuckets(history)

        DenPanel(
            title    = "History",
            subtitle = "Completed and cancelled visits, most recent first.",
            trailing = { SectionCount(if (sessionsState is FirestoreResult.Loading) "" else "${history.size}") },
        ) {
            when {
                sessionsState is FirestoreResult.Loading ->
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) { repeat(2) { ShimmerCard(height = 92.dp) } }
                sessionsState is FirestoreResult.Error ->
                    EmptyHint("Couldn't load history: ${(sessionsState as FirestoreResult.Error).message}", error = true)
                history.isEmpty() ->
                    AuntieBannerEmpty()
                else -> Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    HistorySubsection("Completed", buckets.completed, selecting, timeBlockLabelFor) { selectedBooking = it }
                    HistorySubsection("Cancelled", buckets.cancelled, selecting, timeBlockLabelFor) { selectedBooking = it }
                    HistorySubsection("Other", buckets.other, selecting, timeBlockLabelFor) { selectedBooking = it }
                }
            }
        }

        // B2: booking detail modal (Popup, one instance for all sections). Opens when
        // a card is tapped; needs a real injected client (absent only in fake tests).
        selectedBooking?.let { booking ->
            if (client != null) {
                BookingDetailModal(
                    session = booking,
                    onDismiss = { selectedBooking = null },
                    client = client,
                )
            }
        }
    }
}

/**
 * One organized History bucket: a labelled sub-header with the real count, the
 * most-recent [HISTORY_PAGE] rows, and a Show-more/less toggle so a large legacy
 * import never renders all at once. Returns nothing when the bucket is empty.
 */
@Composable
private fun HistorySubsection(
    label: String,
    bookings: List<KinCareSession>,
    selecting: Boolean,
    timeBlockLabelFor: (KinCareSession) -> String?,
    onOpenDetail: (KinCareSession) -> Unit,
) {
    if (bookings.isEmpty()) return
    var expanded by remember(label, bookings.size) { mutableStateOf(false) }
    val visible = if (expanded) bookings else bookings.take(HISTORY_PAGE)
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text  = label,
                style = AuntieTheme.typography.titleSmall,
                color = AuntieTheme.colors.textPrimary,
            )
            SectionCount("${bookings.size}")
        }
        visible.forEach { booking ->
            BookingCard(
                booking   = booking,
                selecting = selecting,
                onApprove = null,
                onReject  = null,
                onCancel  = null,
                onOpenDetail = { onOpenDetail(booking) },
                timeBlockLabel = timeBlockLabelFor(booking),
            )
        }
        if (bookings.size > HISTORY_PAGE) {
            GhostButton(
                label   = if (expanded) "Show less" else "Show ${bookings.size - HISTORY_PAGE} more",
                onClick = { expanded = !expanded },
            )
        }
    }
}

/** Most-recent rows shown per History subsection before "Show more". */
private const val HISTORY_PAGE = 6

/** Sort key for history rows: the real timestamp the row carries, ISO-sortable. */
internal fun historySortKey(b: KinCareSession): String =
    b.startTime.ifBlank { b.completedAt }.ifBlank { b.departedAt }.ifBlank { b.createdAt }

/** Outcome-split, most-recent-first history buckets. Pure; unit-tested. */
internal data class HistoryBuckets(
    val completed: List<KinCareSession>,
    val cancelled: List<KinCareSession>,
    val other: List<KinCareSession>,
)

private val CANCELLED_STATUSES = setOf("CANCELLED", "CANCELED", "REJECTED")

/**
 * Splits already-filtered history rows by outcome and sorts each bucket by the real
 * timestamp descending (spec 15 item 4). The `other` bucket is a defensive catch-all
 * so an uncategorized status is never silently dropped.
 */
internal fun bookingHistoryBuckets(history: List<KinCareSession>): HistoryBuckets {
    val completed = history.filter { it.status.uppercase() == "COMPLETED" }
        .sortedByDescending { historySortKey(it) }
    val cancelled = history.filter { it.status.uppercase() in CANCELLED_STATUSES }
        .sortedByDescending { historySortKey(it) }
    val other = history.filter {
        it.status.uppercase() != "COMPLETED" && it.status.uppercase() !in CANCELLED_STATUSES
    }.sortedByDescending { historySortKey(it) }
    return HistoryBuckets(completed, cancelled, other)
}

/** A quiet inline empty for History so the section never looks broken. */
@Composable
private fun AuntieBannerEmpty() {
    EmptyHint("No past visits yet.")
}

/**
 * Den stat card (local thin wrapper so the booking sections own their tone
 * without re-importing the Home dashboard's StatCard onClick semantics).
 */
@Composable
private fun StatRowCard(
    label: String,
    value: String,
    trend: String,
    tone: AuntieStatusTone,
    modifier: Modifier = Modifier,
    feature: Boolean = false,
) {
    com.tribetails.auntieos.web.ui.components.StatCard(
        label = label, value = value, trend = trend, tone = tone, modifier = modifier, feature = feature,
    )
}

/** Trailing mono count chip for a DenPanel header. */
@Composable
private fun SectionCount(count: String) {
    if (count.isBlank()) return
    Text(count, style = AuntieTheme.typography.mono, color = AuntieTheme.colors.textDim)
}

// 16.5: one incoming booking envelope (1..N visits). Approve/cancel the whole
// series via manageBookingSeries (backend creates the linked sessions).
@Composable
private fun IncomingSeriesCard(
    series: BookingSeries,
    busy: Boolean,
    locked: Boolean,
    onApprove: () -> Unit,
    onCancel: () -> Unit,
) {
    val c = AuntieTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(c.surface)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(series.kinfolkName.ifBlank { "Kinfolk request" }, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
        Text(
            buildString {
                append(if (series.visitCount == 1) "1 visit" else "${series.visitCount} visits")
                if (series.isSeries) append(" · recurring series")
                if (series.serviceType.isNotBlank()) append(" · ${series.serviceType}")
            },
            style = AuntieTheme.typography.bodySmall,
            color = c.textDim,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryButton(label = if (busy) "Working…" else "Approve series", onClick = onApprove, enabled = !locked)
            GhostButton(label = "Cancel", onClick = onCancel, enabled = !locked)
        }
    }
}

@Composable
private fun BookingCard(
    booking: KinCareSession,
    selecting: Boolean,
    onApprove: (() -> Unit)?,
    onReject: (() -> Unit)?,
    onCancel: (() -> Unit)?,
    onOpenDetail: () -> Unit,
    timeBlockLabel: String? = null,
    selected: Boolean = false,
    onToggleSelect: (() -> Unit)? = null,
) {
    val c    = AuntieTheme.colors
    val tone = bookingStatusTone(booking.status)
    val notePreview = booking.kinfolkNotes.ifBlank { booking.notes }
    val hasName = booking.kinfolkName.isNotBlank()

    GlassSurface(cornerRadius = 18.dp, modifier = Modifier.fillMaxWidth()) {
        // Single Column so the row body, status pill, and note flow vertically
        // instead of z-stacking inside the GlassSurface Box (the old overlap bug).
        // Tap the card body to open its detail (B2). Disabled in select-mode so the
        // checkbox owns the tap there. Child buttons (Approve/Reject/Cancel) consume
        // their own taps, so they never trigger onOpenDetail.
        Column(
            modifier = Modifier
                .then(if (!selecting) Modifier.clickable(onClick = onOpenDetail) else Modifier)
                .padding(14.dp),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(13.dp)) {
                // Bulk multi-select checkbox (only in select-mode, only for cards
                // that support batch action).
                if (selecting && onToggleSelect != null) {
                    AuntieCheckbox(
                        checked = selected,
                        onCheckedChange = { onToggleSelect() },
                    )
                }
                // Left status accent bar (mockup acc-pending/scheduled/completed).
                Box(
                    Modifier
                        .width(4.dp)
                        .height(46.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .background(tone.color(c)),
                )
                AuntieAvatar(
                    initials     = initialsFor(booking.kinfolkName),
                    gradientSeed = booking.kinfolkName.ifBlank { booking._id },
                    size         = 44.dp,
                )
                Column(Modifier.weight(1f)) {
                    Text(
                        text  = if (hasName) booking.kinfolkName else "Unnamed Kinfolk",
                        style = if (hasName) AuntieTheme.typography.titleMedium
                                else AuntieTheme.typography.titleMedium.copy(fontStyle = FontStyle.Italic),
                        color = if (hasName) c.textPrimary else c.textFaint,
                    )
                    Text(
                        text  = "${booking.serviceType.ifBlank { "Visit" }} · ${bookingDateLabel(booking)}" +
                                (timeBlockLabel?.let { " · $it block" } ?: ""),
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }
                // Per-card actions. Hidden while in select-mode (the card shows a
                // checkbox there and the bulk action bar drives the transition).
                if (!selecting) {
                    when {
                        onApprove != null && onReject != null -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            PrimaryButton(label = "Approve", onClick = onApprove)
                            GhostButton(label   = "Reject",  onClick = onReject)
                        }
                        onCancel != null -> GhostButton(label = "Cancel", onClick = onCancel)
                        else -> Unit
                    }
                }
            }

            Spacer(Modifier.height(9.dp))
            AuntieStatusPill(label = booking.status, tone = tone, mono = true)
            if (notePreview.isNotBlank()) {
                Spacer(Modifier.height(7.dp))
                Text(
                    text  = "Note: ${notePreview.take(120)}",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }
        }
    }
}

/**
 * Resolves a human date for a booking row. Legacy/imported kin_care_sessions have
 * an empty [startTime] (the visit date lives in completedAt / createdAt), so the
 * old `startTime.take(10)` produced "No date" on every history row. Fall back
 * through the timestamps that real docs actually carry.
 */
private fun bookingDateLabel(b: KinCareSession): String {
    val raw = b.startTime
        .ifBlank { b.completedAt }
        .ifBlank { b.departedAt }
        .ifBlank { b.createdAt }
    return raw.take(10).ifBlank { "Date pending" }
}

private val SERVICE_TYPES = listOf(
    "Pet Sitting", "Dog Walking", "Overnight", "Daycare", "Drop-In", "Other",
)

/**
 * B9: order KinCare-type chips by parsed duration (ascending) instead of the
 * scrambled Business-Settings Map order. Pulls "<n> hr|min" out of the label;
 * hours convert to minutes; the largest match wins (e.g. "Half-Day 6Hrs" -> 360).
 * Unparseable labels (e.g. "Consultation") sort last, keeping their input order
 * (stable). Default ordering only — the operator can still curate it later.
 */
internal fun sortServiceTypesByDuration(types: List<String>): List<String> {
    val re = Regex("""(\d+)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)""", RegexOption.IGNORE_CASE)
    fun minutes(label: String): Int =
        re.findAll(label)
            .map { mr -> mr.groupValues[1].toInt().let { n -> if (mr.groupValues[2].startsWith("h", true)) n * 60 else n } }
            .maxOrNull() ?: Int.MAX_VALUE
    return types.sortedBy { minutes(it) }
}

@OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, ExperimentalTime::class)
@Composable
private fun BookingCreateScreen(
    vm: BookingViewModel,
    onBack: () -> Unit,
) {
    val c     = AuntieTheme.colors
    val scope = rememberReportingScope()
    val client = remember { FirestoreClient() }
    val kinfolkResult by remember { client.kinfolkStream() }.collectAsState(initial = FirestoreResult.Loading)
    // KinCare types are sourced from Business Settings serviceRates (NOT hardcoded), per the
    // create-booking mockup. Falls back to SERVICE_TYPES when settings have no rates yet.
    val settingsResult by remember { client.businessSettingsStream() }.collectAsState(initial = FirestoreResult.Loading)

    var kinfolkSearch   by remember { mutableStateOf("") }
    var selectedKinfolk by remember { mutableStateOf<Kinfolk?>(null) }
    var serviceType     by remember { mutableStateOf(SERVICE_TYPES[0]) }
    var startDate       by remember { mutableStateOf("") }
    var startTime       by remember { mutableStateOf("") }
    var showDatePicker  by remember { mutableStateOf(false) }
    val today = remember { Clock.System.todayIn(TimeZone.currentSystemDefault()) }
    var kinfolkAdditionalInfo by remember { mutableStateOf("") }
    var adminInternalNotes    by remember { mutableStateOf("") }
    var saving          by remember { mutableStateOf(false) }

    // Phase 14: BOOKING form_schemas (appliesTo == BOOKING) rendered at booking-create
    // time; answers persist into KinCareSession.formValues (one map, shared with the
    // SESSION render context). Mirrors the KIN precare flow.
    val bookingFormValues = remember { mutableStateMapOf<String, String>() }
    val schemaRepo = remember { CloudFormSchemaRepository() }
    var bookingSchemas by remember { mutableStateOf<List<FormSchema>>(emptyList()) }
    var schemaError by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        when (val list = schemaRepo.listSchemas()) {
            is WriteResult.Err -> schemaError = list.message
            is WriteResult.Ok  -> {
                val loaded = mutableListOf<FormSchema>()
                for (id in appliesToSchemaIds(list.value, "BOOKING")) {
                    when (val s = schemaRepo.getSchema(id)) {
                        is WriteResult.Ok  -> loaded.add(s.value)
                        is WriteResult.Err -> schemaError = s.message
                    }
                }
                bookingSchemas = loaded
            }
        }
    }

    val allKinfolk: List<Kinfolk> = (kinfolkResult as? FirestoreResult.Data)
        ?.value?.filter { it.status != "archived" }
        ?: emptyList()

    val filteredKinfolk = if (kinfolkSearch.isBlank()) emptyList()
    else allKinfolk.filter {
        it.displayName.lowercase().contains(kinfolkSearch.trim().lowercase())
    }.take(5)

    val serviceRates: Map<String, String> =
        (settingsResult as? FirestoreResult.Data)?.value?.serviceRates ?: emptyMap()
    val serviceOptions: List<String> = sortServiceTypesByDuration(
        if (serviceRates.isNotEmpty()) serviceRates.keys.toList() else SERVICE_TYPES,
    )

    ScreenScaffold {
        DenScreenHeading(
            kicker     = "Bookings · New booking",
            title      = "New booking",
            subtitle   = "Pick the Kinfolk, KinCare type, date and time.",
            trailing   = { GhostButton(label = "Back", onClick = onBack) },
        )
        Spacer(Modifier.height(20.dp))

        vm.errorMessage?.let { msg ->
            AuntieBanner(
                tone      = AuntieBannerTone.Error,
                title     = "Couldn't save",
                icon      = Lucide.Ban,
                onDismiss = { vm.clearError() },
            ) { Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim) }
            Spacer(Modifier.height(16.dp))
        }

        DenPanel(title = "Details", subtitle = "KinCare applies to the whole household.") {
            // ── Kinfolk selector ───────────────────────────────────────────────
            AuntieFieldLabel(text = "Kinfolk")
            if (selectedKinfolk != null) {
                GlassSurface(cornerRadius = 12.dp, modifier = Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            AuntieAvatar(
                                initials     = initialsFor(selectedKinfolk!!.displayName),
                                gradientSeed = selectedKinfolk!!.displayName,
                                size         = 42.dp,
                            )
                            Column(Modifier.weight(1f)) {
                                Text(selectedKinfolk!!.displayName, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                                if (selectedKinfolk!!.phoneNumber.isNotBlank()) {
                                    Text(selectedKinfolk!!.phoneNumber, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                                }
                            }
                            GhostButton(label = "Change", onClick = { selectedKinfolk = null; kinfolkSearch = "" })
                        }
                    }
                }
            } else {
                BottomBorderField(
                    value         = kinfolkSearch,
                    onValueChange = { kinfolkSearch = it },
                    label         = "Search Kinfolk",
                    placeholder   = "Type a name to search...",
                    modifier      = Modifier.fillMaxWidth(),
                )
                if (filteredKinfolk.isNotEmpty()) {
                    Spacer(Modifier.height(4.dp))
                    GlassSurface(cornerRadius = 12.dp, modifier = Modifier.fillMaxWidth()) {
                        Column(modifier = Modifier.padding(4.dp)) {
                            filteredKinfolk.forEach { kf ->
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clip(RoundedCornerShape(10.dp))
                                        .padding(8.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(11.dp),
                                ) {
                                    AuntieAvatar(initials = initialsFor(kf.displayName), gradientSeed = kf.displayName, size = 36.dp)
                                    Column(Modifier.weight(1f)) {
                                        Text(kf.displayName, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                                        if (kf.phoneNumber.isNotBlank()) {
                                            Text(kf.phoneNumber, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                                        }
                                    }
                                    GhostButton(label = "Select", onClick = { selectedKinfolk = kf; kinfolkSearch = "" })
                                }
                            }
                        }
                    }
                }
                Spacer(Modifier.height(7.dp))
                Text(
                    text  = "Type a name to search. KinCare applies to the whole household, so there is no per-kin selection.",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }
            Spacer(Modifier.height(20.dp))

            // ── KinCare type (from Business Settings serviceRates, NOT hardcoded) ──
            AuntieFieldLabel(text = "KinCare type", optionalNote = "Managed in Business Settings")
            AuntieChipGroup(
                options           = serviceOptions,
                selected          = setOf(serviceType),
                onSelectionChange = { next -> next.firstOrNull()?.let { serviceType = it } },
                label             = { it },
                singleSelect      = true,
                monoSuffix        = { type -> serviceRates[type]?.let { "$$it" } },
                modifier          = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(20.dp))

            // ── Date & time ─────────────────────────────────────────────────────
            // SUGGESTION (mockup): non-consecutive multi-date calendar + Time Block
            // chips + recurring options + optional specific-start-time with a
            // kinfolk-facing disclaimer. requestBooking supports visits[]+pattern
            // server-side, but createBooking/buildSession is single-date/time, so the
            // real fields stay single-date until the multi-date callable is wired.
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                // #1: calendar-style date picker (tap to open) instead of a typed field.
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        "DATE",
                        style = AuntieTheme.typography.labelSmall,
                        color = AuntieTheme.colors.textDim,
                    )
                    Spacer(Modifier.height(6.dp))
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .border(AuntieTheme.dims.borderHairline, AuntieTheme.colors.border, RoundedCornerShape(8.dp))
                            .clickable { showDatePicker = true }
                            .padding(horizontal = 12.dp, vertical = 12.dp),
                    ) {
                        Text(
                            text  = startDate.ifBlank { "Pick a date" },
                            style = AuntieTheme.typography.bodyMedium,
                            color = if (startDate.isBlank()) AuntieTheme.colors.textDim else AuntieTheme.colors.textPrimary,
                        )
                    }
                }
                BottomBorderField(
                    value         = startTime,
                    onValueChange = { startTime = it },
                    label         = "Time (HH:MM)",
                    placeholder   = "09:00",
                    keyboardType  = KeyboardType.Number,
                    modifier      = Modifier.weight(1f),
                )
            }
            // Wasm-safe picker (B1): Material3 DatePickerDialog freezes the app on
            // wasm (invisible modal scrim eats all input). AuntieDatePickerDialog is
            // built over AuntieDialog's Popup and renders on every platform.
            AuntieDatePickerDialog(
                visible = showDatePicker,
                selectedDate = startDate.takeIf { it.isNotBlank() }
                    ?.let { runCatching { kotlinx.datetime.LocalDate.parse(it) }.getOrNull() },
                today = today,
                onPick = { picked ->
                    startDate = picked.toString()
                    showDatePicker = false
                },
                onDismiss = { showDatePicker = false },
            )
            Spacer(Modifier.height(20.dp))

            // ── Kinfolk-facing note (visible to kinfolk, editable until 3hr before) ──
            MultilineField(
                value         = kinfolkAdditionalInfo,
                onValueChange = { kinfolkAdditionalInfo = it },
                label         = "Additional Information for Auntie",
                // TODO(copy): kinfolk-facing placeholder; final wording author-owned.
                placeholder   = "What should Auntie know? Visible to kinfolk; editable until 3hr before visit.",
                minLines      = 3,
                modifier      = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(6.dp))
            Text("Kinfolk-facing.", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            Spacer(Modifier.height(16.dp))

            // ── Admin-internal note (admin-only; hidden from kinfolk forever) ──
            AuntieFieldLabel(text = "Internal · staff only")
            MultilineField(
                value         = adminInternalNotes,
                onValueChange = { adminInternalNotes = it },
                label         = "Internal Notes (admin only)",
                placeholder   = "Hidden from kinfolk. Visible to staff on all KinCare sessions.",
                minLines      = 3,
                modifier      = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(6.dp))
            Text("Admin-internal note.", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            Spacer(Modifier.height(24.dp))

            // ── Custom fields (admin-authored BOOKING form_schemas, Phase 14) ──────
            if (bookingSchemas.isNotEmpty() || schemaError != null) {
                AuntieFieldLabel(text = "Custom fields")
                when {
                    // Fail loud: surface a schema load failure, never swallow it.
                    schemaError != null -> AuntieBanner(
                        tone  = AuntieBannerTone.Error,
                        title = "Couldn't load the custom fields",
                        icon  = Lucide.Ban,
                    ) { Text(schemaError!!, style = AuntieTheme.typography.bodySmall, color = c.textDim) }
                    else -> DynamicFormFields(
                        schemas = bookingSchemas,
                        values = bookingFormValues,
                        onValueChange = { k, v -> bookingFormValues[k] = v },
                    )
                }
                Spacer(Modifier.height(24.dp))
            }

            val hasKinfolk  = selectedKinfolk != null
            val hasDate     = startDate.isNotBlank()
            val canSubmit   = hasKinfolk && hasDate

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                GhostButton(label = "Cancel", onClick = onBack, modifier = Modifier.weight(1f))
                GhostButton(
                    label   = "Save draft",
                    enabled = hasKinfolk && !saving,
                    onClick = {
                        scope.launch {
                            saving = true
                            vm.createBooking(
                                booking = buildSession(selectedKinfolk!!, serviceType, startDate, startTime, kinfolkAdditionalInfo, "DRAFT", bookingFormValues.toMap()),
                                kinfolkFacingNote = kinfolkAdditionalInfo,
                                adminInternalNote = adminInternalNotes,
                            )
                            saving = false
                            if (vm.errorMessage == null) onBack()
                        }
                    },
                    modifier = Modifier.weight(1f),
                )
                PrimaryButton(
                    label   = "Submit request",
                    enabled = canSubmit && !saving,
                    loading = saving,
                    onClick = {
                        scope.launch {
                            saving = true
                            vm.createBooking(
                                booking = buildSession(selectedKinfolk!!, serviceType, startDate, startTime, kinfolkAdditionalInfo, "PENDING", bookingFormValues.toMap()),
                                kinfolkFacingNote = kinfolkAdditionalInfo,
                                adminInternalNote = adminInternalNotes,
                            )
                            saving = false
                            if (vm.errorMessage == null) onBack()
                        }
                    },
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

private fun buildSession(
    kf: Kinfolk,
    serviceType: String,
    date: String,
    time: String,
    notes: String,
    status: String,
    formValues: Map<String, String> = emptyMap(),
) = KinCareSession(
    kinfolkId   = kf._id,
    kinfolkName = kf.displayName,
    serviceType = serviceType,
    startTime   = if (date.isBlank()) "" else "${date}T${time.ifBlank { "00:00" }}:00",
    notes       = notes,
    status      = status,
    formValues  = formValues,
)

/** Two-letter monogram for the avatar, derived from a kinfolk display name. */
private fun initialsFor(name: String): String {
    val parts = name.trim().split(Regex("\\s+")).filter { it.isNotBlank() }
    return when {
        parts.isEmpty() -> "?"
        parts.size == 1 -> parts[0].take(2)
        else            -> "${parts.first().first()}${parts.last().first()}"
    }
}

private fun bookingStatusTone(status: String): AuntieStatusTone = when (status.uppercase()) {
    "DRAFT"     -> AuntieStatusTone.Orange
    "PENDING"   -> AuntieStatusTone.Warning
    "SCHEDULED" -> AuntieStatusTone.Teal
    "COMPLETED" -> AuntieStatusTone.Purple
    "CANCELLED" -> AuntieStatusTone.Muted
    else        -> AuntieStatusTone.Neutral
}

/** Empty Loading flow for the unit-test path where no FirestoreClient is injected. */
private fun <T> emptyLoadingFlow(): kotlinx.coroutines.flow.Flow<FirestoreResult<T>> =
    kotlinx.coroutines.flow.flowOf(FirestoreResult.Loading)

/**
 * Thin adapter so [BookingScreen] can use the real [FirestoreClient] without
 * pulling all of [FirestoreClient]'s platform specifics into [AuntieDataSource].
 * The adapter is internal. Tests inject [FakeAuntieDataSource] directly via
 * [BookingScreenContent].
 */
private class FirestoreClientBookingDataSource(
    private val client: FirestoreClient,
) : com.tribetails.auntieos.web.data.AuntieDataSource {
    override fun invoicesStream() = client.invoicesStream()
    override fun kinfolkStream()  = client.kinfolkStream()
    override fun sessionsStream() = client.sessionsStream()
    override fun paymentsStream() = client.paymentsStream()
    override suspend fun recordPayment(payment: com.tribetails.auntieos.web.data.Payment) = client.recordPayment(payment)

    override fun businessSettingsStream() = client.businessSettingsStream()
    override suspend fun saveBusinessSettings(settings: com.tribetails.auntieos.web.data.BusinessSettings) =
        client.saveBusinessSettings(settings)

    override suspend fun approveBooking(bookingId: String) = client.approveBooking(bookingId)
    override suspend fun rejectBooking(bookingId: String)  = client.rejectBooking(bookingId)
    override suspend fun createBooking(booking: KinCareSession): com.tribetails.auntieos.web.data.WriteResult<String> =
        client.createBookingRequest(booking)
    override fun incomingKinCaresStream() = client.incomingKinCaresStream()
    override suspend fun manageBookingSeries(action: String, kinfolkId: String, batchId: String) =
        client.manageBookingSeries(action, kinfolkId, batchId)

    override fun mediaStream(entityId: String, entityType: String) = client.mediaStream(entityId, entityType)
    override suspend fun uploadMedia(entityId: String, entityType: String, bytes: ByteArray, mimeType: String) =
        client.uploadMedia(entityId, entityType, bytes, mimeType)
    override suspend fun deleteMedia(mediaId: String) = client.deleteMedia(mediaId)

    override fun reportForSessionStream(sessionId: String) = client.reportForSessionStream(sessionId)
    override suspend fun saveReport(report: com.tribetails.auntieos.web.data.KinCareReport) = client.saveReport(report)
    override suspend fun sendReport(report: com.tribetails.auntieos.web.data.KinCareReport, session: com.tribetails.auntieos.web.data.KinCareSession) = client.sendReport(report, session)
    override suspend fun logActivity(entry: com.tribetails.auntieos.web.data.ActivityLogEntry) = client.logActivity(entry)
    override fun trainingDocsStream() = client.trainingDocsStream()
    override fun bookingNotesStream(kinfolkId: String, bookingId: String) =
        client.bookingNotesStream(kinfolkId, bookingId, internal = false)
    override fun bookingInternalNotesStream(kinfolkId: String, bookingId: String) =
        client.bookingNotesStream(kinfolkId, bookingId, internal = true)
    override suspend fun addBookingNote(kinfolkId: String, bookingId: String, body: String) =
        client.addBookingNote(kinfolkId, bookingId, body, internal = false)
    override suspend fun addInternalBookingNote(kinfolkId: String, bookingId: String, body: String) =
        client.addBookingNote(kinfolkId, bookingId, body, internal = true)
    override fun kinTaleCommentsStream(taleId: String, kinfolkId: String) =
        client.kinTaleCommentsStream(taleId, kinfolkId)
    override suspend fun addKinTaleComment(taleId: String, kinfolkId: String, body: String, parentCommentId: String?) =
        client.addKinTaleComment(taleId, kinfolkId, body, parentCommentId)
}
