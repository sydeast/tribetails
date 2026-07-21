package com.tribetails.auntieos.ui.admin

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.gestures.*
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import com.tribetails.auntieos.ui.components.AuntieCheckbox
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import com.tribetails.auntieos.ui.components.AuntieToggle
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.input.pointer.*
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tribetails.auntieos.data.admin.Event
import com.tribetails.auntieos.data.admin.EventType
import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.domain.resolveTimeBlock
import com.tribetails.auntieos.ui.admin.scheduling.*
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.YearMonth
import java.time.format.TextStyle
import java.time.format.DateTimeFormatter
import java.util.Locale
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlin.math.roundToInt

private const val DRAG_MINUTE_SNAP = 15
private const val DRAG_PIXELS_PER_MINUTE = 4f

// Stage 2 Step 2: reschedule from the agenda is wired for real to the
// rescheduleBooking callable. Android differs from web's drag-the-block gesture: a
// long-press on an agenda row (or a tap, then the RESCHEDULE block in the booking
// detail) opens the date/time reschedule, which calls rescheduleBooking with the
// new start/end. No dead "not wired" affordance remains.

private fun parseIsoDateTimeOrNull(value: String): LocalDateTime? =
    runCatching { LocalDateTime.parse(value, DateTimeFormatter.ISO_LOCAL_DATE_TIME) }.getOrNull()

/**
 * #9: snap an "HH:mm" time string to the nearest 15 minutes. Used by the reschedule
 * picker when BusinessSettings.snapRescheduleTo15Min is on. Unparseable input is
 * returned unchanged (fail-safe). Pure; tested.
 */
internal fun snapTimeStringTo15(time: String): String {
    val t = runCatching { LocalTime.parse(time) }.getOrNull() ?: return time
    val total = (t.hour * 60 + t.minute + 7) / 15 * 15 // round to nearest 15
    val wrapped = total % (24 * 60)
    return "%02d:%02d".format(wrapped / 60, wrapped % 60)
}

private fun intervalsOverlap(
    startA: LocalDateTime,
    endA: LocalDateTime,
    startB: LocalDateTime,
    endB: LocalDateTime
): Boolean = startA.isBefore(endB) && endA.isAfter(startB)

enum class CalendarViewType(val displayName: String) {
    DAY("Day"),
    WEEK("Week"),
    MONTH("Month"),
    SIX_WEEKS("6 Weeks")
}

@Composable
fun ScheduleViewScreen(
    onBack: () -> Unit,
    onNavigateToCommunicate: () -> Unit,
    onOpenSchedulingOptions: () -> Unit,
    viewModel: EnhancedSchedulingViewModel
) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    // Time-block descriptor for booking cards (spec 15 item 5). Resolver +
    // Business-Settings timeBlocks now exist (Stage 1 §A.8). Always on, same as
    // Auntie Time's block pills; null (no segment) when unresolved.
    val timeBlocks = state.businessSettings.timeBlocks
    val timeBlockLabelFor: (EnhancedBooking) -> String? = { b ->
        resolveTimeBlock(b.startDateTime, timeBlocks)?.label
    }

    var selectedServiceFilter by remember { mutableStateOf("All Services") }
    var selectedKinfolkFilter by remember { mutableStateOf("All Kinfolk") }

    val filteredBookings = remember(state.bookings, selectedServiceFilter, selectedKinfolkFilter) {
        state.bookings.filter { booking ->
            (selectedServiceFilter == "All Services" || booking.baseServiceTitle == selectedServiceFilter) &&
                (selectedKinfolkFilter == "All Kinfolk" || booking.kinfolkName == selectedKinfolkFilter)
        }
    }

    val pendingBookings = remember(filteredBookings) {
        filteredBookings.filter { it.status == BookingStatus.DRAFT }
    }

    val weekDays = remember(state.selectedDate) { androidWeekStripDays(state.selectedDate) }
    val selectedDayBookings = remember(filteredBookings, state.selectedDate) {
        filteredBookings.filter { booking ->
            parseIsoDateTimeOrNull(booking.startDateTime)?.toLocalDate() == state.selectedDate
        }.sortedBy { it.startDateTime }
    }
    // BLOCKED time slots (Google Calendar busy imports + any other unavailable
    // window) for the selected day, placed by time. Mirrors web's per-slot BusyBlock:
    // filter !isAvailable, group by date, place in the 8a-6p window, generic "Busy"
    // label only (the slot carries hideDetailsFromKinfolk and no event detail).
    val selectedDayBusy = remember(state.timeSlots, state.selectedDate) {
        val key = state.selectedDate.format(DateTimeFormatter.ISO_LOCAL_DATE)
        blockedSlotsByDate(state.timeSlots)[key].orEmpty()
            .mapNotNull { slot -> busyPlacement(slot.startTime, slot.endTime)?.let { slot to it } }
    }

    val agendaLabel = remember(state.selectedDate) {
        if (state.selectedDate == LocalDate.now()) "Today's agenda"
        else state.selectedDate.dayOfWeek.getDisplayName(TextStyle.FULL, Locale.US) + ", " +
            state.selectedDate.format(DateTimeFormatter.ofPattern("MMM d", Locale.US))
    }
    // Calendar-appropriate, data-driven range label that follows the active view
    // (spec 13 item 1). Mirrors the web Schedule reframe. Week is Monday-based to
    // match web `weekStripDays`.
    val rangeLabel = remember(state.selectedDate, state.viewMode) {
        val d = state.selectedDate
        when (state.viewMode) {
            CalendarViewMode.MONTH -> d.format(DateTimeFormatter.ofPattern("MMMM yyyy", Locale.US))
            CalendarViewMode.WEEK -> {
                val monday = d.with(java.time.DayOfWeek.MONDAY)
                val sunday = monday.plusDays(6)
                val startStr = monday.format(DateTimeFormatter.ofPattern("MMM d", Locale.US))
                if (monday.month == sunday.month) "$startStr to ${sunday.dayOfMonth}"
                else "$startStr to ${sunday.format(DateTimeFormatter.ofPattern("MMM d", Locale.US))}"
            }
            else -> d.format(DateTimeFormatter.ofPattern("EEE, MMM d", Locale.US))
        }
    }

    // Booking sections (mirror the Bookings web spec): pending DRAFT requests,
    // confirmed/active ACCEPTED, and history (completed + cancelled).
    val scheduledBookings = remember(filteredBookings) {
        filteredBookings.filter { it.status == BookingStatus.ACCEPTED }
            .sortedBy { it.startDateTime }
    }
    val historyBookings = remember(filteredBookings) {
        filteredBookings.filter { it.status == BookingStatus.COMPLETED || it.status == BookingStatus.REJECTED }
            .sortedByDescending { it.startDateTime }
    }
    // Organized history (spec 15 item 4): split by outcome, each most-recent-first.
    val completedHistory = remember(historyBookings) {
        historyBookings.filter { it.status == BookingStatus.COMPLETED }
    }
    val cancelledHistory = remember(historyBookings) {
        historyBookings.filter { it.status == BookingStatus.REJECTED }
    }

    // Bulk multi-select (Stage 2 tail): wired to the batchUpdateBookings callable.
    // `selecting` reveals checkboxes on pending + scheduled cards; `selectedBookingIds`
    // is the working set fed to the batch action bar.
    var selecting by remember { mutableStateOf(false) }
    var selectedBookingIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    // Selectable bookings = pending DRAFT + confirmed ACCEPTED (the transitionable set).
    val selectableIds = remember(pendingBookings, scheduledBookings) {
        (pendingBookings + scheduledBookings).map { it.id }.toSet()
    }

    AuntieScreenScaffold(
        title = "Calendar",
        onBack = onBack,
        actions = {
            AuntieIconBtn(onClick = onOpenSchedulingOptions) {
                Icon(Lucide.SlidersHorizontal, contentDescription = "Scheduling options", tint = AuntieTheme.colors.kinfolkOrange)
            }
        },
    ) {
      Box(modifier = Modifier.fillMaxSize()) {
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            item {
                // Reframed as a calendar (spec 13 item 1): label follows active view +
                // range, not "this week's runs". The mislabeled route/active/upcoming
                // subtitle moved to Auntie Time (spec 14). TODO(auntie copy): any final
                // descriptive subtitle wording is author-owned; range below is derived.
                DenScreenHeading(
                    kicker = "The Den · Schedule",
                    title = "Schedule",
                    accentTail = "${state.viewMode.displayName.lowercase(Locale.US)}.",
                    subtitle = rangeLabel,
                )
            }

            // Write errors surface as a persistent banner, never a swallowed toast.
            state.errorMessage?.let { error ->
                item {
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        title = "Something went wrong",
                        icon = Lucide.Ban,
                        onDismiss = { viewModel.clearError() },
                    ) {
                        Text(error, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
                    }
                }
            }

            // Google Calendar "Busy" blocks are written server-side to
            // booking_time_slots by syncGoogleCalendarBusyEvents and streamed live
            // into state.timeSlots. Surface a load error loud ONLY when calendar sync
            // is configured (#4, 2026-06-08): with no calendarSyncId there is nothing
            // to load, so a permission/empty error must not surface. Mirrors web.
            if (state.businessSettings.calendarSyncId.isNotBlank()) state.busyError?.let { busyErr ->
                item {
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        title = "Couldn't load busy blocks",
                        icon = Lucide.Ban,
                    ) {
                        Text(busyErr, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
                    }
                }
            }

            if (state.conflictingBookings.isNotEmpty()) {
                item {
                    AuntieBanner(
                        tone = AuntieBannerTone.Warning,
                        title = "Scheduling conflicts detected",
                        icon = Lucide.TriangleAlert,
                    ) {
                        Text(
                            "${state.conflictingBookings.size} scheduling conflicts detected.",
                            style = AuntieTheme.typography.bodySmall,
                            color = AuntieTheme.colors.textDim,
                        )
                    }
                }
            }

            if (state.isLoading) {
                item { AuntieLinearProgress(modifier = Modifier.fillMaxWidth()) }
            }

            // ── Controls: week nav + view picker + select toggle ──
            item {
                ScheduleControls(
                    selectedDate = state.selectedDate,
                    viewMode = state.viewMode,
                    selecting = selecting,
                    onToggleSelect = {
                        selecting = !selecting
                        if (!selecting) selectedBookingIds = emptySet()
                    },
                    onView = { mode -> viewModel.changeViewMode(mode) },
                    onPrev = {
                        val delta = if (state.viewMode == CalendarViewMode.MONTH) state.selectedDate.minusMonths(1) else state.selectedDate.minusWeeks(1)
                        viewModel.selectDate(delta)
                    },
                    onNext = {
                        val delta = if (state.viewMode == CalendarViewMode.MONTH) state.selectedDate.plusMonths(1) else state.selectedDate.plusWeeks(1)
                        viewModel.selectDate(delta)
                    },
                    onToday = { viewModel.selectDate(LocalDate.now()) },
                )
            }

            // B7 (A8): colour key for the schedule. Reads the auntie's REAL service
            // types (BusinessSettings.serviceRates), ordered by duration (B9), painted
            // with the same serviceTone the agenda rows use so the key always matches.
            val legendTypes = sortServiceTypesByDuration(state.businessSettings.serviceRates.keys.toList())
            if (legendTypes.isNotEmpty()) {
                item {
                    DenPanel(title = "Service key") {
                        ScheduleLegend(legendTypes)
                    }
                }
            }

            // Bulk action bar (Stage 2 tail): when selecting, apply ONE transition to
            // all checked bookings via batchUpdateBookings. Fail-loud: the VM surfaces
            // the server updated/failed counts in a banner below.
            if (selecting) {
                item {
                    BulkBookingActionBar(
                        selectedCount = selectedBookingIds.size,
                        inFlight = state.bulkBookingInFlight,
                        allSelected = selectableIds.isNotEmpty() && selectedBookingIds == selectableIds,
                        onSelectAll = {
                            selectedBookingIds = if (selectedBookingIds == selectableIds) emptySet() else selectableIds
                        },
                        onAction = { action ->
                            viewModel.batchUpdateBookings(selectedBookingIds.toList(), action)
                            selectedBookingIds = emptySet()
                            selecting = false
                        },
                    )
                }
            }

            // Bulk result (Stage 2 tail): server updated/failed counts, dismissable.
            state.bulkBookingMessage?.let { msg ->
                item {
                    AuntieBanner(
                        tone = if (msg.contains("failed", ignoreCase = true)) AuntieBannerTone.Warning else AuntieBannerTone.Success,
                        title = "Bulk update",
                        icon = Lucide.CircleCheckBig,
                        onDismiss = { viewModel.clearBulkBookingMessage() },
                    ) {
                        Text(msg, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
                    }
                }
            }

            // ── Stage 3 / 16.5: incoming MyTribe booking requests (per-envelope) ──
            state.incomingError?.let { msg ->
                item {
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        title = "Incoming requests",
                        icon = Lucide.CircleAlert,
                        onDismiss = { viewModel.clearIncomingError() },
                    ) { Text(msg, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.error) }
                }
            }
            state.seriesActionMessage?.let { msg ->
                item {
                    AuntieBanner(
                        tone = AuntieBannerTone.Success,
                        title = "Booking series",
                        icon = Lucide.CircleCheckBig,
                        onDismiss = { viewModel.clearSeriesActionMessage() },
                    ) { Text(msg, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim) }
                }
            }
            if (state.incomingSeries.isNotEmpty()) {
                item {
                    DenPanel(
                        title = "Incoming requests",
                        subtitle = "New requests from MyTribe. Approve a whole series at once; approving creates the visits on Auntie Time.",
                    ) {
                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            state.incomingSeries.forEach { series ->
                                IncomingSeriesRow(
                                    series = series,
                                    inFlight = state.seriesActionBatchId == series.batchId,
                                    actionsLocked = state.seriesActionBatchId != null,
                                    onApprove = { viewModel.approveSeries(series) },
                                    onCancel = { viewModel.cancelSeries(series) },
                                )
                            }
                        }
                    }
                }
            }

            // ── Stat row: counts mirror the booking sections ──
            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    StatCard(
                        label = "Pending approval",
                        value = pendingBookings.size.toString(),
                        trend = "awaiting a reply",
                        tone = AuntieStatusTone.Orange,
                        feature = true,
                        modifier = Modifier.weight(1f),
                    )
                    StatCard(
                        label = "Scheduled",
                        value = scheduledBookings.size.toString(),
                        trend = "on the books",
                        tone = AuntieStatusTone.Teal,
                        modifier = Modifier.weight(1f),
                    )
                    StatCard(
                        label = "History",
                        value = historyBookings.size.toString(),
                        trend = "completed and cancelled",
                        tone = AuntieStatusTone.Purple,
                        modifier = Modifier.weight(1f),
                    )
                }
            }

            // ── Day agenda: selected day's visits ──
            item {
                DenPanel(
                    title = agendaLabel,
                    subtitle = "Tap a visit to open its booking detail and notes. Long-press an approved visit to reschedule it.",
                ) {
                    if (selectedDayBookings.isEmpty() && selectedDayBusy.isEmpty()) {
                        EmptyHint("No Kin Care sessions on this day.")
                    } else {
                        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                            // Read-only "Busy" bands placed by their start time (Google
                            // Calendar busy imports + manual blocks). No event detail:
                            // hideDetailsFromKinfolk, generic "Busy" label only. Parity
                            // with web BusyBlock; off-window/unparseable slots drop out.
                            selectedDayBusy.forEach { (slot, placement) ->
                                BusyBand(slot = slot, placement = placement)
                            }
                            selectedDayBookings.forEach { booking ->
                                AdminBookingAgendaRow(
                                    booking = booking,
                                    onClick = { viewModel.selectBooking(booking) },
                                    // Long-press is the Android reschedule entry point: it
                                    // opens the same booking detail whose RESCHEDULE block
                                    // writes via the real rescheduleBooking callable.
                                    onLongClick = { viewModel.selectBooking(booking) },
                                )
                            }
                        }
                    }
                }
            }

            // #12: calendar moved below the day agenda so the small day-detail card is
            // seen first, not folded under the dominant calendar.
            item {
                DenPanel(
                    title = "Calendar",
                    subtitle = "Tap a day to inspect its visits.",
                ) {
                    if (state.viewMode == CalendarViewMode.MONTH) {
                        EnhancedMonthView(
                            currentDate     = state.selectedDate,
                            bookings        = filteredBookings,
                            timeSlots       = state.timeSlots,
                            onBookingClick  = { viewModel.selectBooking(it) },
                            onDateClick     = { date ->
                                viewModel.selectDate(date)
                                viewModel.changeViewMode(CalendarViewMode.DAY)
                            },
                            onTimeSlotClick = {},
                        )
                    } else if (state.viewMode != CalendarViewMode.DAY) {
                        AndroidWeekStrip(
                            days         = weekDays,
                            selectedDate = state.selectedDate,
                            hasItems     = { day ->
                                filteredBookings.any { booking ->
                                    parseIsoDateTimeOrNull(booking.startDateTime)?.toLocalDate() == day
                                }
                            },
                            onSelect = { date -> viewModel.selectDate(date) },
                        )
                    } else {
                        EmptyHint("Day view. The selected day's agenda is above.")
                    }
                }
            }

            // ── Pending approval (DRAFT requests) ──
            item {
                DenPanel(
                    title = "Pending approval",
                    subtitle = "New booking requests waiting on your call.",
                    trailing = {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            // AO-25: create a multi-date / recurring request (envelope model).
                            AuntieTextBtn(onClick = { viewModel.showNewRequestDialog() }) { Text("+ New request") }
                            SectionCount(pendingBookings.size.toString())
                        }
                    },
                ) {
                    if (pendingBookings.isEmpty()) {
                        EmptyHint("No requests waiting. New bookings land here for approval.")
                    } else {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            pendingBookings.forEach { booking ->
                                BookingSectionCard(
                                    booking = booking,
                                    onClick = { viewModel.selectBooking(booking) },
                                    onApprove = { viewModel.approveBooking(booking) },
                                    onReject = { viewModel.cancelBooking(booking) },
                                    onCancel = null,
                                    timeBlockLabel = timeBlockLabelFor(booking),
                                    selecting = selecting,
                                    selected = booking.id in selectedBookingIds,
                                    onToggleSelect = {
                                        selectedBookingIds = if (booking.id in selectedBookingIds)
                                            selectedBookingIds - booking.id else selectedBookingIds + booking.id
                                    },
                                )
                            }
                        }
                    }
                }
            }

            // ── Scheduled (ACCEPTED) ──
            item {
                DenPanel(
                    title = "Scheduled",
                    subtitle = "Approved visits on the calendar.",
                    trailing = { SectionCount(scheduledBookings.size.toString()) },
                ) {
                    if (scheduledBookings.isEmpty()) {
                        EmptyHint("Nothing scheduled. Approved requests appear here.")
                    } else {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            scheduledBookings.forEach { booking ->
                                BookingSectionCard(
                                    booking = booking,
                                    onClick = { viewModel.selectBooking(booking) },
                                    onApprove = null,
                                    onReject = null,
                                    onCancel = { viewModel.cancelBooking(booking) },
                                    timeBlockLabel = timeBlockLabelFor(booking),
                                    selecting = selecting,
                                    selected = booking.id in selectedBookingIds,
                                    onToggleSelect = {
                                        selectedBookingIds = if (booking.id in selectedBookingIds)
                                            selectedBookingIds - booking.id else selectedBookingIds + booking.id
                                    },
                                )
                            }
                        }
                    }
                }
            }

            // ── History (organized: sorted desc, split Completed / Cancelled, capped) ──
            // Auntie's complaint was "raw rows". Split by outcome, cap each subsection
            // (Show more), and show the real count instead of a literal "recent".
            item {
                DenPanel(
                    title = "History",
                    subtitle = "Completed and cancelled visits, most recent first.",
                    trailing = { SectionCount(historyBookings.size.toString()) },
                ) {
                    if (historyBookings.isEmpty()) {
                        EmptyHint("No past visits yet.")
                    } else {
                        Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
                            HistorySubsection("Completed", completedHistory, timeBlockLabelFor) { viewModel.selectBooking(it) }
                            HistorySubsection("Cancelled", cancelledHistory, timeBlockLabelFor) { viewModel.selectBooking(it) }
                        }
                    }
                }
            }

            item { Spacer(Modifier.height(72.dp)) }
        }

        AuntieFab(
            onClick  = { viewModel.showAddBookingDialog() },
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp)
        ) {
            Icon(Lucide.Plus, contentDescription = "Add Booking", tint = AuntieTheme.colors.background)
        }

        if (state.showAddBookingDialog) {
            AddEnhancedBookingDialog(
                baseServices = state.baseServices.filter { it.isActive },
                allKinfolk   = state.allKinfolk,
                bookingMode  = state.bookingMode,
                initialDate  = state.selectedDate,
                onDismiss    = { viewModel.hideAddBookingDialog() },
                onSave       = { booking, internalNote ->
                    viewModel.createBooking(booking, internalNote)
                    viewModel.hideAddBookingDialog()
                },
                bookingSchemas = state.bookingFormSchemas,
                schemaError    = state.bookingSchemaError,
            )
        }

        if (state.showNewRequestDialog) {
            NewBookingRequestDialog(
                allKinfolk   = state.allKinfolk,
                baseServices = state.baseServices.filter { it.isActive },
                inFlight     = state.newRequestInFlight,
                error        = state.newRequestError,
                onDismiss    = { viewModel.hideNewRequestDialog() },
                onCreate     = { kinfolkId, visits, notes, pattern, weeklyDays ->
                    viewModel.createBookingRequest(kinfolkId, visits, notes, pattern, weeklyDays)
                },
            )
        }

        if (state.showConflictDialog && state.conflictingBookings.isNotEmpty()) {
            ConflictResolutionDialog(
                conflicts          = state.conflictingBookings,
                availabilityResult = state.availabilityResult,
                onResolve          = { forceCreate -> viewModel.resolveConflict(forceCreate) },
                onDismiss          = { viewModel.resolveConflict(false) }
            )
        } else if (state.showConflictDialog && state.availabilityResult != null) {
            ConflictResolutionDialog(
                conflicts          = emptyList(),
                availabilityResult = state.availabilityResult,
                onResolve          = { forceCreate -> viewModel.resolveConflict(forceCreate) },
                onDismiss          = { viewModel.resolveConflict(false) }
            )
        }

        state.selectedBooking?.let { booking ->
            BookingDetailsDialog(
                booking      = booking,
                onDismiss    = { viewModel.selectBooking(null) },
                onApprove    = { viewModel.approveBooking(booking) },
                onCancel     = { viewModel.cancelBooking(booking) },
                onArchive    = { reason -> viewModel.archiveBooking(booking.id, reason) },
                onUnarchive  = { viewModel.unarchiveBooking(booking.id) },
                onSaveNotes  = { newNotes, newSpecial ->
                    viewModel.updateBooking(
                        booking.copy(notes = newNotes, specialInstructions = newSpecial)
                    )
                },
                onReschedule = { date, time ->
                    // #9: snap the chosen reschedule time to 15 min when the operator
                    // enabled it (BusinessSettings.snapRescheduleTo15Min). Android
                    // reschedules via the date/time picker (no drag), so the snap
                    // applies here. Parity with the web drag snap.
                    val snapped = if (state.businessSettings.snapRescheduleTo15Min) snapTimeStringTo15(time) else time
                    viewModel.rescheduleSelectedBooking(date, snapped)
                },
            )
        }
      }
    }
}

/**
 * Den schedule controls: a mono range navigator (‹ Month yyyy ›), the view
 * SegmentedPicker, a Today reset, and a Select toggle for the (gated) bulk path.
 * Stacks for phone width via a wrapping Column of rows.
 */
@Composable
private fun ScheduleControls(
    selectedDate: LocalDate,
    viewMode: CalendarViewMode,
    selecting: Boolean,
    onToggleSelect: () -> Unit,
    onView: (CalendarViewMode) -> Unit,
    onPrev: () -> Unit,
    onNext: () -> Unit,
    onToday: () -> Unit,
) {
    val c = AuntieTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            // Range navigator: ‹  Month yyyy  ›
            Row(
                modifier = Modifier
                    .clip(RoundedCornerShape(13.dp))
                    .background(c.surface2)
                    .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(13.dp))
                    .padding(horizontal = 4.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                AuntieIconBtn(onClick = onPrev, modifier = Modifier.size(32.dp)) {
                    Icon(Lucide.ChevronLeft, contentDescription = "Previous", tint = c.textDim)
                }
                Text(
                    text = selectedDate.format(DateTimeFormatter.ofPattern("MMM yyyy", Locale.US)),
                    style = AuntieTheme.typography.mono.copy(fontSize = 12.5.sp),
                    color = c.textPrimary,
                    modifier = Modifier.padding(horizontal = 4.dp),
                )
                AuntieIconBtn(onClick = onNext, modifier = Modifier.size(32.dp)) {
                    Icon(Lucide.ChevronRight, contentDescription = "Next", tint = c.textDim)
                }
            }
            Spacer(Modifier.weight(1f))
            AuntieTextBtn(onClick = onToday) { Text("Today") }
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            SegmentedPicker(
                options = CalendarViewMode.entries.filter { it != CalendarViewMode.AGENDA },
                selected = viewMode,
                onSelect = onView,
                label = { it.displayName },
            )
            Spacer(Modifier.weight(1f))
            GhostButton(
                label = if (selecting) "Done" else "Select",
                onClick = onToggleSelect,
            )
        }
    }
}

/**
 * Bulk action bar (Stage 2 tail) shown while multi-selecting bookings. Surfaces a
 * Select-all toggle, the live selected count, and one button per transition
 * (Approve / Reject / Cancel) that fires batchUpdateBookings on the working set.
 * Actions disable while a batch is in flight or nothing is selected.
 */
@Composable
private fun BulkBookingActionBar(
    selectedCount: Int,
    inFlight: Boolean,
    allSelected: Boolean,
    onSelectAll: () -> Unit,
    onAction: (String) -> Unit,
) {
    val canAct = selectedCount > 0 && !inFlight
    DenPanel(title = "Bulk actions") {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                GhostButton(
                    label = if (allSelected) "Clear all" else "Select all",
                    onClick = onSelectAll,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    text = if (inFlight) "Applying…" else "$selectedCount selected",
                    style = AuntieTheme.typography.mono.copy(fontSize = 12.sp),
                    color = AuntieTheme.colors.textDim,
                )
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                PrimaryButton(label = "Approve", enabled = canAct, onClick = { onAction("APPROVE") })
                GhostButton(label = "Reject", onClick = { if (canAct) onAction("REJECT") }, enabled = canAct)
                GhostButton(label = "Cancel", onClick = { if (canAct) onAction("CANCEL") }, enabled = canAct)
            }
        }
    }
}

/** Trailing mono count chip for a DenPanel header. */
@Composable
private fun SectionCount(count: String) {
    if (count.isBlank()) return
    Text(count, style = AuntieTheme.typography.mono, color = AuntieTheme.colors.textDim)
}

/**
 * Day-agenda row in the Den vocabulary (mirrors the web ScheduleScreen DayAgenda):
 * a service-toned accent bar, the start time, then title + ServicePill +
 * AuntieStatusPill and a subtitle. The whole row opens the booking detail.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun AdminBookingAgendaRow(
    booking: EnhancedBooking,
    onClick: () -> Unit,
    onLongClick: () -> Unit = onClick,
) {
    val c = AuntieTheme.colors
    val accent = bookingServiceTint(booking)
    val serviceText = booking.baseServiceTitle.ifBlank { booking.title.ifBlank { "Kin Care Visit" } }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(18.dp))
            .background(c.surfaceGlass)
            .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(18.dp))
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .width(4.dp)
                .height(64.dp)
                .clip(RoundedCornerShape(999.dp))
                .background(accent),
        )
        Text(
            text = bookingDisplayTime(booking.startDateTime),
            style = AuntieTheme.typography.titleLarge,
            color = c.textPrimary,
        )
        Box(modifier = Modifier.width(1.dp).height(64.dp).background(c.borderSoft))
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = serviceText,
                    style = AuntieTheme.typography.titleMedium,
                    color = c.textPrimary,
                    modifier = Modifier.weight(1f),
                )
                AuntieStatusPill(
                    label = bookingStatusBadge(booking),
                    tone = bookingStatusTone(booking),
                    showDot = true,
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (booking.baseServiceTitle.isNotBlank()) {
                    ServicePill(booking.baseServiceTitle, serviceTone(booking.baseServiceTitle))
                }
                Text(text = bookingSubtitle(booking), style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        }
    }
}

/** Most-recent rows shown per History subsection before "Show more". */
private const val HISTORY_PAGE = 6

/**
 * One organized History bucket (mirrors the web HistorySubsection): a labelled
 * sub-header with the real count, the most-recent [HISTORY_PAGE] rows, and a
 * Show-more/less toggle so a large legacy import never renders all at once.
 */
@Composable
private fun HistorySubsection(
    label: String,
    bookings: List<EnhancedBooking>,
    timeBlockLabelFor: (EnhancedBooking) -> String?,
    onSelect: (EnhancedBooking) -> Unit,
) {
    if (bookings.isEmpty()) return
    var expanded by remember(label, bookings.size) { mutableStateOf(false) }
    val visible = if (expanded) bookings else bookings.take(HISTORY_PAGE)
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(label, style = AuntieTheme.typography.titleSmall, color = AuntieTheme.colors.textPrimary)
            SectionCount(bookings.size.toString())
        }
        visible.forEach { booking ->
            BookingSectionCard(
                booking = booking,
                onClick = { onSelect(booking) },
                onApprove = null,
                onReject = null,
                onCancel = null,
                timeBlockLabel = timeBlockLabelFor(booking),
            )
        }
        if (bookings.size > HISTORY_PAGE) {
            GhostButton(
                label = if (expanded) "Show less" else "Show ${bookings.size - HISTORY_PAGE} more",
                onClick = { expanded = !expanded },
            )
        }
    }
}

/**
 * Booking-section card (mirrors the web BookingScreen BookingCard): status accent
 * bar, name + service/date subtitle, optional per-card actions, then a status pill
 * and note preview. Used by the Pending / Scheduled / History sections.
 */
@Composable
private fun BookingSectionCard(
    booking: EnhancedBooking,
    onClick: () -> Unit,
    onApprove: (() -> Unit)?,
    onReject: (() -> Unit)?,
    onCancel: (() -> Unit)?,
    timeBlockLabel: String? = null,
    selecting: Boolean = false,
    selected: Boolean = false,
    onToggleSelect: (() -> Unit)? = null,
) {
    val c = AuntieTheme.colors
    val tone = bookingStatusTone(booking)
    val hasName = booking.kinfolkName.isNotBlank()
    // In select mode the whole card toggles selection instead of opening the detail.
    val cardClick = if (selecting && onToggleSelect != null) onToggleSelect else onClick

    GlassSurface(cornerRadius = 18.dp, modifier = Modifier.fillMaxWidth().clickable(onClick = cardClick)) {
        Column(modifier = Modifier.padding(14.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(13.dp)) {
                if (selecting && onToggleSelect != null) {
                    AuntieCheckbox(checked = selected, onCheckedChange = { onToggleSelect() })
                }
                Box(
                    Modifier
                        .width(4.dp)
                        .height(46.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .background(tone.color(c)),
                )
                Column(Modifier.weight(1f)) {
                    Text(
                        text = if (hasName) booking.kinfolkName else "Unnamed Kinfolk",
                        style = if (hasName) AuntieTheme.typography.titleMedium
                                else AuntieTheme.typography.titleMedium.copy(fontStyle = FontStyle.Italic),
                        color = if (hasName) c.textPrimary else c.textFaint,
                    )
                    Text(
                        text = "${booking.baseServiceTitle.ifBlank { booking.title.ifBlank { "Visit" } }} · ${bookingDateLabel(booking)}" +
                            (timeBlockLabel?.let { " · $it block" } ?: ""),
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }
                when {
                    // Per-card actions are suppressed in select mode (the bulk bar drives transitions).
                    selecting -> Unit
                    onApprove != null && onReject != null -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PrimaryButton(label = "Approve", onClick = onApprove)
                        GhostButton(label = "Reject", onClick = onReject)
                    }
                    onCancel != null -> GhostButton(label = "Cancel", onClick = onCancel)
                    else -> Unit
                }
            }
            Spacer(Modifier.height(9.dp))
            AuntieStatusPill(label = bookingStatusBadge(booking), tone = tone, mono = true)
            val notePreview = booking.specialInstructions.ifBlank { booking.notes }
            if (notePreview.isNotBlank()) {
                Spacer(Modifier.height(7.dp))
                Text(
                    text = "Note: ${notePreview.take(120)}",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }
        }
    }
}

/**
 * B7 (A8): the schedule colour key. Mirror of the web ScheduleLegend — one swatch per
 * real service type plus the "Other / unmapped" and "Busy" fallbacks, so the operator
 * can read what the agenda colours mean.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ScheduleLegend(serviceTypes: List<String>) {
    val c = AuntieTheme.colors
    FlowRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(18.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        serviceTypes.forEach { type -> LegendItem(serviceTone(type).color(c), type) }
        LegendItem(c.textFaint, "Other / unmapped")
        LegendItem(c.textFaint.copy(alpha = 0.45f), "Busy")
    }
}

@Composable
private fun LegendItem(swatch: Color, label: String) {
    val c = AuntieTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
        Box(
            modifier = Modifier
                .size(11.dp)
                .clip(RoundedCornerShape(4.dp))
                .background(swatch),
        )
        Text(label, style = AuntieTheme.typography.bodySmall, color = c.textDim)
    }
}

/** Service-type tint for a booking, faded when cancelled, via the shared serviceTone. */
@Composable
private fun bookingServiceTint(booking: EnhancedBooking): Color {
    val c = AuntieTheme.colors
    if (booking.status == BookingStatus.REJECTED) return c.textFaint
    return serviceTone(booking.baseServiceTitle.ifBlank { booking.title }).color(c)
}

/** Den status tone for a booking, keyed to its lifecycle (active-now is its own tone). */
private fun bookingStatusTone(booking: EnhancedBooking): AuntieStatusTone = when (booking.status) {
    BookingStatus.COMPLETED -> AuntieStatusTone.Purple
    BookingStatus.ACCEPTED  -> if (isBookingActiveNow(booking)) AuntieStatusTone.Success else AuntieStatusTone.Teal
    BookingStatus.DRAFT     -> AuntieStatusTone.Orange
    BookingStatus.REJECTED  -> AuntieStatusTone.Muted
}

/** SCREAMING_SNAKE status badge label, mirroring the web schedule statusBadge. */
private fun bookingStatusBadge(booking: EnhancedBooking): String = when (booking.status) {
    BookingStatus.COMPLETED -> "COMPLETED"
    BookingStatus.ACCEPTED  -> if (isBookingActiveNow(booking)) "ACTIVE" else "CONFIRMED"
    BookingStatus.DRAFT     -> "PENDING"
    BookingStatus.REJECTED  -> "CANCELLED"
}

/** Human date for a booking row, mirroring the web bookingDateLabel fallback chain. */
private fun bookingDateLabel(booking: EnhancedBooking): String {
    val raw = booking.startDateTime.ifBlank { booking.endDateTime }
    return raw.take(10).ifBlank { "Date pending" }
}

@Suppress("unused")
@Composable
private fun KinfolkScheduleHero(
    familyLabel: String,
    hasPending: Boolean,
    onMessageAuntie: () -> Unit,
) {
    Row(
        modifier              = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalAlignment     = Alignment.CenterVertically,
    ) {
        Text(text = familyLabel, modifier = Modifier.weight(1f), style = AuntieTheme.typography.displayLarge, color = AuntieTheme.colors.background)

        Box(
            modifier = Modifier.size(56.dp).clip(CircleShape).background(AuntieTheme.colors.surfaceGlass).border(1.dp, AuntieTheme.colors.borderSoft, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Box(modifier = Modifier.size(14.dp).clip(CircleShape).background(if (hasPending) AuntieTheme.colors.error else AuntieTheme.colors.success))
        }

        Box(
            modifier = Modifier
                .height(72.dp)
                .clip(RoundedCornerShape(28.dp))
                .background(AuntieTheme.colors.surfaceGlass)
                .border(1.dp, AuntieTheme.colors.borderSoft, RoundedCornerShape(28.dp))
                .clickable(onClick = onMessageAuntie)
                .padding(horizontal = 16.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text("Message\nAuntie", style = AuntieTheme.typography.headlineMedium, color = AuntieTheme.colors.secondary)
        }
    }
}

/**
 * Den week strip: 7 day cells with a mono day-of-week kicker. The selected day
 * fills primary, today carries the coral accent, and a small dot marks days with
 * visits. Sits inside a DenPanel so it carries no card chrome of its own.
 */
@Composable
private fun AndroidWeekStrip(
    days: List<LocalDate>,
    selectedDate: LocalDate,
    hasItems: (LocalDate) -> Boolean,
    onSelect: (LocalDate) -> Unit,
) {
    val c = AuntieTheme.colors
    Row(
        modifier              = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        days.forEach { day ->
            val selected = day == selectedDate
            val isToday  = day == LocalDate.now()
            Column(
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(14.dp))
                    .background(
                        when {
                            selected -> c.primary
                            isToday  -> c.coral.copy(alpha = 0.10f)
                            else     -> Color.Transparent
                        }
                    )
                    .border(
                        AuntieTheme.dims.borderHairline,
                        if (selected) Color.Transparent else c.borderSoft,
                        RoundedCornerShape(14.dp),
                    )
                    .clickable { onSelect(day) }
                    .padding(vertical = 9.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Text(
                    text  = day.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.US),
                    style = AuntieTheme.typography.mono.copy(fontSize = 10.5.sp, letterSpacing = 1.sp),
                    color = when {
                        selected -> c.background
                        isToday  -> c.coral
                        else     -> c.textFaint
                    },
                )
                Text(
                    text  = day.dayOfMonth.toString(),
                    style = AuntieTheme.typography.titleMedium,
                    color = when {
                        selected -> c.background
                        isToday  -> c.coral
                        else     -> c.textPrimary
                    },
                )
                if (hasItems(day)) {
                    Box(modifier = Modifier.size(5.dp).clip(CircleShape).background(if (selected) c.background.copy(alpha = 0.7f) else c.primary))
                } else {
                    Spacer(Modifier.height(5.dp))
                }
            }
        }
    }
}

@Suppress("unused")
@Composable
private fun ScreenshotBookingCard(
    booking: EnhancedBooking,
    onClick: () -> Unit,
) {
    val accent = screenshotStatusAccent(booking)
    val status = screenshotStatusLabel(booking)

    AuntieCard(
        modifier       = Modifier.fillMaxWidth().clickable(onClick = onClick),
        border         = BorderStroke(1.dp, AuntieTheme.colors.borderSoft),
        shape          = RoundedCornerShape(28.dp),
        containerColor = AuntieTheme.colors.surfaceGlass,
    ) {
        Row(modifier = Modifier.fillMaxWidth().padding(14.dp), horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(modifier = Modifier.width(6.dp).height(116.dp).clip(RoundedCornerShape(999.dp)).background(accent))
            Text(text = bookingDisplayTime(booking.startDateTime), style = AuntieTheme.typography.headlineLarge, color = AuntieTheme.colors.textPrimary)
            Box(modifier = Modifier.width(1.dp).height(84.dp).background(AuntieTheme.colors.borderSoft))
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(text = booking.title.ifBlank { booking.baseServiceTitle.ifBlank { "Kin Care Visit" } }, style = AuntieTheme.typography.headlineLarge, color = AuntieTheme.colors.textPrimary)
                    Box(modifier = Modifier.clip(RoundedCornerShape(999.dp)).background(accent.copy(alpha = 0.16f)).padding(horizontal = 12.dp, vertical = 6.dp)) {
                        Text(text = status, style = AuntieTheme.typography.headlineSmall, color = accent)
                    }
                }
                Text(text = bookingSubtitle(booking), style = AuntieTheme.typography.headlineMedium, color = AuntieTheme.colors.textDim)
                booking.notes.takeIf { it.isNotBlank() }?.let {
                    Text(text = it, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim, maxLines = 2)
                }
            }
        }
    }
}

@Suppress("unused")
@Composable
private fun scheduleBackdropBrush(): Brush = Brush.verticalGradient(
    colors = listOf(
        AuntieTheme.colors.primary,
        AuntieTheme.colors.secondary,
        AuntieTheme.colors.tertiary,
        AuntieTheme.colors.accent,
    )
)

private fun androidWeekStripDays(selected: LocalDate): List<LocalDate> {
    val monday = selected.minusDays((selected.dayOfWeek.value - 1).toLong())
    return List(7) { monday.plusDays(it.toLong()) }
}

@Composable
private fun screenshotStatusAccent(booking: EnhancedBooking): Color = when (booking.status) {
    BookingStatus.COMPLETED -> AuntieTheme.colors.secondary
    BookingStatus.ACCEPTED  -> if (isBookingActiveNow(booking)) AuntieTheme.colors.secondary else AuntieTheme.colors.accent
    BookingStatus.DRAFT     -> AuntieTheme.colors.warning
    BookingStatus.REJECTED  -> AuntieTheme.colors.textFaint
}

private fun screenshotStatusLabel(booking: EnhancedBooking): String = when (booking.status) {
    BookingStatus.COMPLETED -> "COMPLETED"
    BookingStatus.ACCEPTED  -> if (isBookingActiveNow(booking)) "ACTIVE" else "CONFIRMED"
    BookingStatus.DRAFT     -> "PENDING"
    BookingStatus.REJECTED  -> "CANCELLED"
}

private fun isBookingActiveNow(booking: EnhancedBooking): Boolean {
    if (booking.status != BookingStatus.ACCEPTED) return false
    val now   = LocalDateTime.now()
    val start = parseIsoDateTimeOrNull(booking.startDateTime) ?: return false
    val end   = parseIsoDateTimeOrNull(booking.endDateTime)   ?: return false
    return !now.isBefore(start) && now.isBefore(end)
}

private fun bookingSubtitle(booking: EnhancedBooking): String {
    val who      = booking.kinfolkName.ifBlank { "Kinfolk" }
    val duration = runCatching {
        val start   = parseIsoDateTimeOrNull(booking.startDateTime) ?: return@runCatching null
        val end     = parseIsoDateTimeOrNull(booking.endDateTime)   ?: return@runCatching null
        val minutes = java.time.Duration.between(start, end).toMinutes().toInt()
        if (minutes > 0) "$who • $minutes mins" else who
    }.getOrDefault(who)
    return duration ?: who
}

private fun bookingDisplayTime(iso: String): String = runCatching {
    val dateTime = LocalDateTime.parse(iso, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
    dateTime.format(DateTimeFormatter.ofPattern("h:mm a", Locale.US))
}.getOrDefault(iso)

@Composable
fun QuickStatCard(
    title: String,
    value: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    color: Color
) {
    AuntieCard {
        Row(modifier = Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(8.dp))
            Column {
                Text(text = value, style = AuntieTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = AuntieTheme.colors.textPrimary)
                Text(text = title, style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textPrimary.copy(alpha = 0.7f))
            }
        }
    }
}

/**
 * Read-only "Busy" band for a BLOCKED [BookingTimeSlot] (Google Calendar busy import
 * or any other unavailable window) in the day agenda. Parity with the web BusyBlock:
 * shows NO event detail (the slot has hideDetailsFromKinfolk set and carries no
 * title), only a generic "Busy" label and its placed time range. The band height
 * reflects the slot's duration so longer blocks read as bigger, matching how the web
 * grid sizes a band by [BusyPlacement.heightMinutes]. Not clickable. The android
 * agenda is a vertical list (no pixel time-grid), so [BusyPlacement.topMinutes] is not
 * used for absolute Y here; ordering by start time is handled upstream.
 */
@Composable
private fun BusyBand(slot: BookingTimeSlot, placement: BusyPlacement) {
    val c = AuntieTheme.colors
    // Map duration to a readable band height: ~0.9dp/min, clamped so a short block is
    // still tappable-height and a long one doesn't dominate the agenda.
    val bandHeight = (placement.heightMinutes * 0.9f).dp.coerceIn(28.dp, 120.dp)
    val range = busyRangeLabel(slot.startTime, slot.endTime)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .height(bandHeight)
            .clip(RoundedCornerShape(11.dp))
            .background(c.textFaint.copy(alpha = if (c.isDark) 0.18f else 0.12f).compositeOver(c.surface))
            .border(AuntieTheme.dims.borderHairline, c.textFaint.copy(alpha = 0.45f), RoundedCornerShape(11.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(
            text = "Busy",
            style = AuntieTheme.typography.titleSmall,
            fontWeight = FontWeight.Bold,
            color = c.textDim,
            maxLines = 1,
        )
        if (range.isNotBlank()) {
            Text(
                text = range,
                style = AuntieTheme.typography.labelSmall,
                color = c.textDim.copy(alpha = 0.8f),
                maxLines = 1,
            )
        }
    }
}

/** "HH:mm to HH:mm" range label for a busy band; tolerant of a blank/short end. */
private fun busyRangeLabel(start: String, end: String): String {
    val s = start.take(5)
    if (s.isBlank()) return ""
    val e = end.take(5)
    return if (e.isNotBlank() && e != s) "$s to $e" else s
}

@Composable
fun EnhancedMonthView(
    currentDate: LocalDate,
    bookings: List<EnhancedBooking>,
    timeSlots: List<BookingTimeSlot>,
    onBookingClick: (EnhancedBooking) -> Unit,
    onDateClick: (LocalDate) -> Unit,
    onTimeSlotClick: (BookingTimeSlot) -> Unit
) {
    val yearMonth     = YearMonth.from(currentDate)
    val daysInMonth   = yearMonth.lengthOfMonth()
    val firstDayOfWeek = yearMonth.atDay(1).dayOfWeek.value % 7

    Column {
        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            listOf("S", "M", "T", "W", "T", "F", "S").forEach { day ->
                Text(day, modifier = Modifier.weight(1f), textAlign = TextAlign.Center, fontWeight = FontWeight.Bold)
            }
        }
        Spacer(Modifier.height(8.dp))

        var currentDay = 1
        for (week in 0..5) {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                for (dayOfWeek in 0..6) {
                    if (week == 0 && dayOfWeek < firstDayOfWeek || currentDay > daysInMonth) {
                        Box(modifier = Modifier.weight(1f).aspectRatio(1f))
                    } else {
                        val date        = yearMonth.atDay(currentDay)
                        val dayBookings = bookings.filter { booking ->
                            try {
                                val bookingDate = LocalDateTime.parse(booking.startDateTime, DateTimeFormatter.ISO_LOCAL_DATE_TIME).toLocalDate()
                                bookingDate == date
                            } catch (e: Exception) { false }
                        }
                        val dayTimeSlots = timeSlots.filter { it.date == date.format(DateTimeFormatter.ISO_LOCAL_DATE) }
                        EnhancedDayCell(
                            date           = date,
                            bookings       = dayBookings,
                            timeSlots      = dayTimeSlots,
                            modifier       = Modifier.weight(1f),
                            onDateClick    = onDateClick,
                            onBookingClick = onBookingClick,
                            onTimeSlotClick = onTimeSlotClick
                        )
                        currentDay++
                    }
                }
            }
        }
    }
}

@Composable
fun EnhancedDayCell(
    date: LocalDate,
    bookings: List<EnhancedBooking>,
    timeSlots: List<BookingTimeSlot>,
    modifier: Modifier,
    onDateClick: (LocalDate) -> Unit,
    onBookingClick: (EnhancedBooking) -> Unit,
    onTimeSlotClick: (BookingTimeSlot) -> Unit
) {
    val isToday        = date == LocalDate.now()
    val blockedSlots   = timeSlots.filter { !it.isAvailable }
    val hasBlockedSlots = blockedSlots.isNotEmpty()
    val blockedDensity = (blockedSlots.size / 4f).coerceIn(0f, 1f)

    Column(
        modifier = modifier
            .aspectRatio(1f)
            .padding(2.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(
                when {
                    isToday         -> AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.2f)
                    hasBlockedSlots -> Color.Red.copy(alpha = 0.1f)
                    else            -> AuntieTheme.colors.surface
                }
            )
            .clickable { onDateClick(date) }
            .padding(4.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        if (hasBlockedSlots) {
            Box(modifier = Modifier.fillMaxWidth().height(3.dp).clip(RoundedCornerShape(2.dp)).background(Color.Red.copy(alpha = 0.25f + (blockedDensity * 0.45f))))
            Spacer(Modifier.height(2.dp))
        }
        Text(
            text       = date.dayOfMonth.toString(),
            color      = when {
                isToday         -> AuntieTheme.colors.kinfolkOrange
                hasBlockedSlots -> Color.Red
                else            -> AuntieTheme.colors.textPrimary
            },
            fontWeight = if (isToday) FontWeight.Bold else FontWeight.Normal
        )
        if (bookings.isNotEmpty()) {
            Spacer(Modifier.height(2.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                bookings.take(3).forEach { booking ->
                    Box(
                        modifier = Modifier.size(4.dp).clip(CircleShape).background(
                            when (booking.status) {
                                BookingStatus.ACCEPTED  -> Color.Green
                                BookingStatus.DRAFT     -> AuntieTheme.colors.warning
                                BookingStatus.COMPLETED -> AuntieTheme.colors.kinfolkOrange
                                BookingStatus.REJECTED  -> Color.Red
                            }
                        ).clickable { onBookingClick(booking) }
                    )
                }
                if (bookings.size > 3) {
                    Text(text = "+${bookings.size - 3}", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textPrimary.copy(alpha = 0.6f))
                }
            }
        }
        if (hasBlockedSlots) {
            Spacer(Modifier.height(1.dp))
            Row(
                horizontalArrangement = Arrangement.spacedBy(2.dp),
                verticalAlignment     = Alignment.CenterVertically,
                modifier              = Modifier.clickable { blockedSlots.firstOrNull()?.let(onTimeSlotClick) }
            ) {
                repeat(minOf(3, blockedSlots.size)) { index ->
                    Box(modifier = Modifier.size(width = 5.dp, height = 2.dp).clip(RoundedCornerShape(2.dp)).background(Color.Red.copy(alpha = 0.45f + (index * 0.15f))))
                }
                Text(text = "${blockedSlots.size}blk", style = AuntieTheme.typography.labelSmall, color = Color.Red.copy(alpha = 0.8f))
            }
        }
    }
}

@Suppress("unused")
@Composable
fun EnhancedAgendaView(
    currentDate: LocalDate,
    bookings: List<EnhancedBooking>,
    viewMode: CalendarViewType,
    dragState: DragState?,
    onBookingClick: (EnhancedBooking) -> Unit,
    onStartDrag: (EnhancedBooking, LocalDateTime) -> Unit,
    onDragUpdate: (LocalDateTime) -> Unit,
    onDragComplete: () -> Unit,
    onDragCancel: () -> Unit
) {
    val dragConflictCount = remember(bookings, dragState) {
        val drag = dragState ?: return@remember 0
        bookings.count { booking ->
            if (booking.id == drag.draggedBooking.id) false
            else {
                val otherStart = parseIsoDateTimeOrNull(booking.startDateTime)
                val otherEnd   = parseIsoDateTimeOrNull(booking.endDateTime)
                otherStart != null && otherEnd != null && intervalsOverlap(drag.newStartTime, drag.newEndTime, otherStart, otherEnd)
            }
        }
    }

    val filteredBookings = when (viewMode) {
        CalendarViewType.DAY -> bookings.filter { booking ->
            try {
                LocalDateTime.parse(booking.startDateTime, DateTimeFormatter.ISO_LOCAL_DATE_TIME).toLocalDate() == currentDate
            } catch (e: Exception) { false }
        }
        CalendarViewType.WEEK -> {
            val startOfWeek = currentDate.minusDays(currentDate.dayOfWeek.value.toLong() - 1)
            val endOfWeek   = startOfWeek.plusDays(6)
            bookings.filter { booking ->
                try {
                    val bookingDate = LocalDateTime.parse(booking.startDateTime, DateTimeFormatter.ISO_LOCAL_DATE_TIME).toLocalDate()
                    !bookingDate.isBefore(startOfWeek) && !bookingDate.isAfter(endOfWeek)
                } catch (e: Exception) { false }
            }
        }
        else -> bookings
    }

    if (filteredBookings.isEmpty()) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("No bookings scheduled.", color = Color.Gray)
        }
    } else {
        LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (dragState != null) {
                item {
                    AuntieCard(
                        containerColor = if (dragConflictCount > 0) Color.Red.copy(alpha = 0.12f) else AuntieTheme.colors.warning.copy(alpha = 0.12f)
                    ) {
                        Row(modifier = Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(
                                imageVector = if (dragConflictCount > 0) Lucide.CircleAlert else Lucide.GripVertical,
                                contentDescription = null,
                                tint = if (dragConflictCount > 0) Color.Red else AuntieTheme.colors.warning,
                                modifier = Modifier.size(18.dp)
                            )
                            Spacer(Modifier.width(8.dp))
                            Text(
                                text  = if (dragConflictCount > 0) "Drag preview overlaps $dragConflictCount booking(s)." else "Drag preview active. Release to save new time.",
                                style = AuntieTheme.typography.bodySmall,
                                color = AuntieTheme.colors.textPrimary
                            )
                        }
                    }
                }
            }
            items(filteredBookings.sortedBy { it.startDateTime }) { booking ->
                val isDraggedBooking = dragState?.draggedBooking?.id == booking.id
                EnhancedBookingCard(
                    booking             = booking,
                    isDragging          = isDraggedBooking,
                    onBookingClick      = onBookingClick,
                    onStartDrag         = onStartDrag,
                    onDragUpdate        = onDragUpdate,
                    onDragComplete      = onDragComplete,
                    onDragCancel        = onDragCancel,
                    dragPreviewStart    = if (isDraggedBooking) dragState?.newStartTime else null,
                    dragPreviewEnd      = if (isDraggedBooking) dragState?.newEndTime else null,
                    hasPreviewConflict  = isDraggedBooking && dragConflictCount > 0
                )
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Suppress("unused")
@Composable
fun EnhancedBookingCard(
    booking: EnhancedBooking,
    isDragging: Boolean,
    onBookingClick: (EnhancedBooking) -> Unit,
    onStartDrag: (EnhancedBooking, LocalDateTime) -> Unit,
    onDragUpdate: (LocalDateTime) -> Unit,
    onDragComplete: () -> Unit,
    onDragCancel: () -> Unit,
    dragPreviewStart: LocalDateTime? = null,
    dragPreviewEnd: LocalDateTime? = null,
    hasPreviewConflict: Boolean = false
) {
    AuntieCard(
        containerColor = if (isDragging) AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.3f) else AuntieTheme.colors.surface2,
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onBookingClick(booking) }
            .pointerInput(booking.id) {
                var dragBaseStartTime: LocalDateTime? = null
                var accumulatedY = 0f
                detectDragGestures(
                    onDragStart = {
                        try {
                            val startTime = LocalDateTime.parse(booking.startDateTime, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
                            dragBaseStartTime = startTime
                            accumulatedY = 0f
                            onStartDrag(booking, startTime)
                        } catch (e: Exception) { }
                    },
                    onDragEnd = { dragBaseStartTime = null; accumulatedY = 0f; onDragComplete() },
                    onDragCancel = { dragBaseStartTime = null; accumulatedY = 0f; onDragCancel() }
                ) { change, dragAmount ->
                    val baseStartTime = dragBaseStartTime
                    if (baseStartTime != null) {
                        accumulatedY += dragAmount.y
                        val rawMinutes     = (accumulatedY / DRAG_PIXELS_PER_MINUTE).roundToInt()
                        val snappedMinutes = (rawMinutes / DRAG_MINUTE_SNAP.toFloat()).roundToInt() * DRAG_MINUTE_SNAP
                        onDragUpdate(baseStartTime.plusMinutes(snappedMinutes.toLong()))
                    }
                    change.consume()
                }
            }
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.weight(1f)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(text = booking.title, fontWeight = FontWeight.Bold, color = AuntieTheme.colors.textPrimary)
                        Spacer(Modifier.width(8.dp))
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(4.dp))
                                .background(
                                    when (booking.status) {
                                        BookingStatus.ACCEPTED  -> Color.Green.copy(alpha = 0.2f)
                                        BookingStatus.DRAFT     -> AuntieTheme.colors.warning.copy(alpha = 0.2f)
                                        BookingStatus.COMPLETED -> AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.2f)
                                        BookingStatus.REJECTED  -> Color.Red.copy(alpha = 0.2f)
                                    }
                                )
                                .padding(horizontal = 6.dp, vertical = 2.dp)
                        ) {
                            Text(
                                text  = booking.status.name,
                                style = AuntieTheme.typography.labelSmall,
                                color = when (booking.status) {
                                    BookingStatus.ACCEPTED  -> Color.Green
                                    BookingStatus.DRAFT     -> AuntieTheme.colors.warning
                                    BookingStatus.COMPLETED -> AuntieTheme.colors.kinfolkOrange
                                    BookingStatus.REJECTED  -> Color.Red
                                }
                            )
                        }
                    }
                    if (booking.kinfolkName.isNotBlank()) {
                        Text(text = "Client: ${booking.kinfolkName}", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary.copy(alpha = 0.7f), modifier = Modifier.padding(top = 2.dp))
                    }
                    if (booking.kinNames.isNotEmpty()) {
                        Text(text = "Pets: ${booking.kinNames.joinToString(", ")}", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary.copy(alpha = 0.7f), modifier = Modifier.padding(top = 2.dp))
                    }
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text(text = "$${String.format("%.2f", booking.totalPrice)}", style = AuntieTheme.typography.titleMedium, fontWeight = FontWeight.Bold, color = AuntieTheme.colors.kinfolkOrange)
                    if (booking.bookingMode == BookingMode.TIME_BLOCK) {
                        Icon(Lucide.Clock3, contentDescription = "Time Block", modifier = Modifier.size(16.dp), tint = Color.Blue)
                    }
                }
            }
            Spacer(Modifier.height(8.dp))
            Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                val bookingTimeText = remember(booking.startDateTime, booking.endDateTime) {
                    runCatching {
                        val startTime = LocalDateTime.parse(booking.startDateTime, DateTimeFormatter.ISO_LOCAL_DATE_TIME)
                        val endTime   = LocalDateTime.parse(booking.endDateTime,   DateTimeFormatter.ISO_LOCAL_DATE_TIME)
                        "${startTime.format(DateTimeFormatter.ofPattern("MMM dd, h:mm a"))} - ${endTime.format(DateTimeFormatter.ofPattern("h:mm a"))}"
                    }.getOrElse { "Invalid time format" }
                }
                Text(text = bookingTimeText, style = AuntieTheme.typography.bodyMedium, color = if (bookingTimeText == "Invalid time format") Color.Red else AuntieTheme.colors.textPrimary)
                if (booking.baseServiceTitle.isNotBlank()) {
                    Text(text = booking.baseServiceTitle, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.kinfolkOrange)
                }
            }
            if (booking.notes.isNotBlank()) {
                Spacer(Modifier.height(8.dp))
                Text(text = booking.notes, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary.copy(alpha = 0.6f))
            }
            if (isDragging && dragPreviewStart != null && dragPreviewEnd != null) {
                Spacer(Modifier.height(8.dp))
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background(if (hasPreviewConflict) Color.Red.copy(alpha = 0.15f) else AuntieTheme.colors.warning.copy(alpha = 0.15f))
                ) {
                    Row(modifier = Modifier.padding(horizontal = 8.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            imageVector = if (hasPreviewConflict) Lucide.TriangleAlert else Lucide.GripVertical,
                            contentDescription = null,
                            tint = if (hasPreviewConflict) Color.Red else AuntieTheme.colors.warning,
                            modifier = Modifier.size(14.dp)
                        )
                        Spacer(Modifier.width(6.dp))
                        Text(
                            text  = "Preview: ${dragPreviewStart.format(DateTimeFormatter.ofPattern("h:mm a"))} - ${dragPreviewEnd.format(DateTimeFormatter.ofPattern("h:mm a"))}",
                            style = AuntieTheme.typography.labelSmall,
                            color = AuntieTheme.colors.textPrimary
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun TimeSlotManagementDialog(
    selectedDate: LocalDate,
    blockedSlots: List<BookingTimeSlot>,
    onDismiss: () -> Unit,
    onBlock: (LocalDate, String, String, String) -> Unit,
    onUnblock: (String) -> Unit
) {
    var startTime by remember { mutableStateOf("09:00") }
    var endTime   by remember { mutableStateOf("17:00") }
    var reason    by remember { mutableStateOf("Blocked") }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        AuntieCard(
            modifier       = Modifier.fillMaxWidth(0.95f).fillMaxHeight(0.85f),
            containerColor = AuntieTheme.colors.background
        ) {
            Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Text(text = "Manage Time Blocks", style = AuntieTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = AuntieTheme.colors.textPrimary)
                    AuntieIconBtn(onClick = onDismiss) { Icon(Lucide.X, contentDescription = "Close", tint = AuntieTheme.colors.textDim) }
                }
                Text(text = selectedDate.format(DateTimeFormatter.ofPattern("EEEE, MMM d")), style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary.copy(alpha = 0.75f))
                Box(modifier = Modifier.padding(vertical = 10.dp).fillMaxWidth().height(1.dp).background(AuntieTheme.colors.border))
                AuntieField(value = startTime, onValueChange = { startTime = it }, label = "START TIME (HH:MM)", modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                AuntieField(value = endTime, onValueChange = { endTime = it }, label = "END TIME (HH:MM)", modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(8.dp))
                AuntieField(value = reason, onValueChange = { reason = it }, label = "REASON", modifier = Modifier.fillMaxWidth())
                Spacer(Modifier.height(12.dp))
                PrimaryButton(
                    label    = "Block Time",
                    onClick  = { onBlock(selectedDate, startTime.trim(), endTime.trim(), reason.trim().ifBlank { "Blocked" }) },
                    modifier = Modifier.fillMaxWidth()
                )
                Box(modifier = Modifier.padding(vertical = 10.dp).fillMaxWidth().height(1.dp).background(AuntieTheme.colors.border))
                Text(text = "Blocked Slots", style = AuntieTheme.typography.titleMedium, fontWeight = FontWeight.Medium, color = AuntieTheme.colors.textPrimary)
                if (blockedSlots.isEmpty()) {
                    Box(modifier = Modifier.fillMaxWidth().padding(vertical = 16.dp), contentAlignment = Alignment.Center) {
                        Text("No blocked slots for this day.", color = AuntieTheme.colors.textPrimary.copy(alpha = 0.7f))
                    }
                } else {
                    LazyColumn(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(blockedSlots) { slot ->
                            AuntieCard(containerColor = AuntieTheme.colors.surface) {
                                Row(modifier = Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(text = "${slot.startTime} - ${slot.endTime}", style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary, fontWeight = FontWeight.Medium)
                                        if (slot.notes.isNotBlank()) {
                                            Text(text = slot.notes, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary.copy(alpha = 0.7f))
                                        }
                                    }
                                    AuntieTextBtn(onClick = { onUnblock(slot.id) }) { Text("Unblock") }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AddEnhancedBookingDialog(
    baseServices: List<BaseService>,
    allKinfolk: List<Kinfolk>,
    bookingMode: BookingMode,
    initialDate: LocalDate,
    onDismiss: () -> Unit,
    onSave: (EnhancedBooking, String) -> Unit,
    bookingSchemas: List<FormSchema> = emptyList(),
    schemaError: String? = null,
) {
    var selectedKinfolk by remember { mutableStateOf<Kinfolk?>(null) }
    var selectedService by remember { mutableStateOf<BaseService?>(baseServices.firstOrNull()) }
    // Phase 14: answers to BOOKING-placed custom fields; persisted into EnhancedBooking.formValues.
    val formValues = remember { mutableStateMapOf<String, String>() }

    val datePickerState = rememberDatePickerState(
        initialSelectedDateMillis = initialDate.toEpochDay() * 86_400_000L
    )
    var showDatePicker by remember { mutableStateOf(false) }
    val selectedDateDisplay = remember(datePickerState.selectedDateMillis) {
        datePickerState.selectedDateMillis?.let {
            LocalDate.ofEpochDay(it / 86_400_000L).format(DateTimeFormatter.ofPattern("EEE, MMM d yyyy"))
        } ?: initialDate.format(DateTimeFormatter.ofPattern("EEE, MMM d yyyy"))
    }

    var startTimeText by remember { mutableStateOf("09:00") }
    var endTimeText   by remember { mutableStateOf("10:00") }
    var timeError     by remember { mutableStateOf<String?>(null) }
    var notes         by remember { mutableStateOf("") }
    var internalNotes by remember { mutableStateOf("") }
    var publishImmediately by remember { mutableStateOf(false) }

    if (showDatePicker) {
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton    = { AuntieTextBtn(onClick = { showDatePicker = false }) { Text("OK") } },
            dismissButton    = { AuntieTextBtn(onClick = { showDatePicker = false }) { Text("Cancel") } }
        ) { DatePicker(state = datePickerState) }
    }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        AuntieCard(
            modifier       = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            shape          = RoundedCornerShape(20.dp),
            containerColor = AuntieTheme.colors.surface,
        ) {
            LazyColumn(modifier = Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                item {
                    Text("New Booking", style = AuntieTheme.typography.titleLarge, color = AuntieTheme.colors.textPrimary)
                }
                item {
                    AuntieDropdownField(
                        value       = selectedKinfolk,
                        options     = listOf<Kinfolk?>(null) + allKinfolk,
                        onSelect    = { selectedKinfolk = it },
                        displayText = { it?.displayName ?: "Select kinfolk *" },
                        label       = "KINFOLK",
                        modifier    = Modifier.fillMaxWidth()
                    )
                }
                item {
                    AuntieDropdownField(
                        value       = selectedService,
                        options     = listOf<BaseService?>(null) + baseServices,
                        onSelect    = { selectedService = it },
                        displayText = { it?.title ?: "Select service *" },
                        label       = "SERVICE",
                        modifier    = Modifier.fillMaxWidth()
                    )
                }
                item {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .border(1.dp, AuntieTheme.colors.border, RoundedCornerShape(8.dp))
                            .background(AuntieTheme.colors.surface)
                            .clickable { showDatePicker = true }
                            .padding(horizontal = 12.dp, vertical = 16.dp),
                    ) {
                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Text(selectedDateDisplay, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary)
                            Icon(Lucide.CalendarDays, contentDescription = "Pick date", tint = AuntieTheme.colors.kinfolkOrange, modifier = Modifier.size(20.dp))
                        }
                    }
                }
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        AuntieField(value = startTimeText, onValueChange = { startTimeText = it; timeError = null }, label = "START (HH:MM)", modifier = Modifier.weight(1f), singleLine = true)
                        AuntieField(value = endTimeText,   onValueChange = { endTimeText = it; timeError = null },   label = "END (HH:MM)",   modifier = Modifier.weight(1f), singleLine = true)
                    }
                    timeError?.let {
                        Text(it, color = AuntieTheme.colors.error, style = AuntieTheme.typography.bodySmall)
                    }
                }
                item {
                    AuntieField(
                        value = notes,
                        onValueChange = { notes = it },
                        label = "ADDITIONAL INFO FOR AUNTIE",
                        placeholder = "Visible to kinfolk; editable until 3hr before visit.",
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = false,
                        minLines = 2,
                    )
                }
                item {
                    AuntieField(
                        value = internalNotes,
                        onValueChange = { internalNotes = it },
                        label = "INTERNAL NOTES (ADMIN ONLY)",
                        placeholder = "Hidden from kinfolk. Visible to staff on every session of this booking.",
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = false,
                        minLines = 2,
                    )
                }
                item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        AuntieToggle(
                            checked         = publishImmediately,
                            onCheckedChange = { publishImmediately = it },
                        )
                        Spacer(Modifier.width(8.dp))
                        Text("Confirm immediately (skip draft)", style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary)
                    }
                }
                // Phase 14: admin-authored BOOKING custom fields. Only shown when a
                // BOOKING schema exists or a load failed; answers ride into formValues.
                if (bookingSchemas.isNotEmpty() || schemaError != null) {
                    item {
                        Text("CUSTOM FIELDS", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.kinfolkOrange)
                    }
                    item {
                        when {
                            // Fail loud: surface a schema load failure, never swallow it.
                            schemaError != null -> Text(
                                "Couldn't load the custom fields: $schemaError",
                                style = AuntieTheme.typography.bodySmall,
                                color = AuntieTheme.colors.error,
                            )
                            else -> DynamicFormFields(
                                schemas = bookingSchemas,
                                values = formValues,
                                onValueChange = { k, v -> formValues[k] = v },
                            )
                        }
                    }
                }
                item {
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        GhostButton(label = "Cancel", onClick = onDismiss, modifier = Modifier.weight(1f))
                        PrimaryButton(
                            label    = if (publishImmediately) "Confirm" else "Save Draft",
                            onClick  = {
                                val epochDay  = datePickerState.selectedDateMillis?.let { it / 86_400_000L } ?: initialDate.toEpochDay()
                                val date      = LocalDate.ofEpochDay(epochDay)
                                val startTime = runCatching { LocalTime.parse(startTimeText) }.getOrNull()
                                val endTime   = runCatching { LocalTime.parse(endTimeText) }.getOrNull()
                                if (startTime == null || endTime == null) { timeError = "Use HH:mm format (e.g. 09:00)"; return@PrimaryButton }
                                if (!endTime.isAfter(startTime)) { timeError = "End time must be after start"; return@PrimaryButton }
                                val svc = selectedService
                                onSave(
                                    EnhancedBooking(
                                        title            = svc?.title ?: "New Booking",
                                        baseServiceId    = svc?.id ?: "",
                                        baseServiceTitle = svc?.title ?: "",
                                        kinfolkId        = selectedKinfolk?.id ?: "",
                                        kinfolkName      = selectedKinfolk?.displayName ?: "",
                                        startDateTime    = LocalDateTime.of(date, startTime).format(DateTimeFormatter.ISO_LOCAL_DATE_TIME),
                                        endDateTime      = LocalDateTime.of(date, endTime).format(DateTimeFormatter.ISO_LOCAL_DATE_TIME),
                                        bookingMode      = bookingMode,
                                        notes            = notes,
                                        status           = if (publishImmediately) BookingStatus.ACCEPTED else BookingStatus.DRAFT,
                                        formValues       = formValues.toMap(),
                                    ),
                                    internalNotes,
                                )
                            },
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun ConflictResolutionDialog(
    conflicts: List<EnhancedBooking>,
    availabilityResult: BookingAvailabilityResult? = null,
    onResolve: (Boolean) -> Unit,
    onDismiss: () -> Unit
) {
    var waitlistChecked by remember { mutableStateOf(false) }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        AuntieCard(modifier = Modifier.fillMaxWidth(0.9f), containerColor = AuntieTheme.colors.background) {
            Column(modifier = Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Scheduling Conflicts Detected", style = AuntieTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = AuntieTheme.colors.textPrimary)

                availabilityResult?.message?.let {
                    Text(it, color = AuntieTheme.colors.textPrimary)
                }
                if (conflicts.isNotEmpty()) {
                    Text("The following bookings conflict with your new booking:", color = AuntieTheme.colors.textPrimary)
                    conflicts.forEach { conflict ->
                        Text(text = "• ${conflict.title} - ${conflict.kinfolkName}", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary)
                    }
                }
                if (availabilityResult?.suggestedOptions?.isNotEmpty() == true) {
                    Text("Next available options:", color = AuntieTheme.colors.textPrimary)
                    availabilityResult.suggestedOptions.forEach { option ->
                        Text(text = "• ${option.startDateTime.replace('T', ' ')}", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary)
                    }
                }
                if (availabilityResult?.showWaitlist == true) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        AuntieCheckbox(checked = waitlistChecked, onCheckedChange = { waitlistChecked = it })
                        Text("Add this kinfolk to waitlist for this time block", color = AuntieTheme.colors.textPrimary)
                    }
                }

                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    AuntieTextBtn(onClick = { onResolve(false) }) { Text("Cancel") }
                    Spacer(Modifier.width(8.dp))
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .background(AuntieTheme.colors.error.copy(alpha = 0.15f))
                            .clickable { onResolve(true) }
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        Text("Force Create", color = AuntieTheme.colors.error, style = AuntieTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
    }
}

@Composable
fun BookingDetailsDialog(
    booking: EnhancedBooking,
    onDismiss: () -> Unit,
    onApprove: () -> Unit,
    onCancel: () -> Unit,
    onArchive: (reason: String) -> Unit = {},
    onUnarchive: () -> Unit = {},
    onSaveNotes: (notes: String, specialInstructions: String) -> Unit = { _, _ -> },
    onReschedule: (date: String, time: String) -> Unit = { _, _ -> },
) {
    var notes              by remember(booking.id) { mutableStateOf(booking.notes) }
    var specialInstructions by remember(booking.id) { mutableStateOf(booking.specialInstructions) }
    var showArchiveDialog  by remember { mutableStateOf(false) }
    var archiveReason      by remember { mutableStateOf("") }
    // Reschedule prefill from the current start (wires Stage-1 rescheduleBooking, §A.9).
    var reDate by remember(booking.id) { mutableStateOf(booking.startDateTime.take(10)) }
    var reTime by remember(booking.id) {
        mutableStateOf(if (booking.startDateTime.length >= 16 && booking.startDateTime[10] == 'T') booking.startDateTime.substring(11, 16) else "")
    }

    val startMs = runCatching {
        java.time.LocalDateTime.parse(booking.startDateTime)
            .atZone(java.time.ZoneId.systemDefault())
            .toInstant()
            .toEpochMilli()
    }.getOrNull()
    val locked = com.tribetails.auntieos.ui.admin.scheduling.isNoteEditLocked(
        nowMs   = System.currentTimeMillis(),
        startMs = startMs,
    )
    val isArchived = booking.archivedAt.isNotBlank()
    val notesDirty = notes != booking.notes || specialInstructions != booking.specialInstructions

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        AuntieCard(modifier = Modifier.fillMaxWidth(0.9f), containerColor = AuntieTheme.colors.background) {
            Column(modifier = Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Booking Details", style = AuntieTheme.typography.titleLarge, fontWeight = FontWeight.Bold, color = AuntieTheme.colors.textPrimary)
                    if (isArchived) {
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(999.dp))
                                .background(AuntieTheme.colors.error.copy(alpha = 0.15f))
                                .padding(horizontal = 8.dp, vertical = 4.dp),
                        ) {
                            Text("ARCHIVED", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.error)
                        }
                    }
                }
                Text("Service: ${booking.baseServiceTitle.ifBlank { "Not set" }}", color = AuntieTheme.colors.textPrimary)
                Text("Kinfolk: ${booking.kinfolkName.ifBlank { "Not set" }}", color = AuntieTheme.colors.textPrimary)
                if (booking.kinNames.isNotEmpty()) {
                    Text("Kin: ${booking.kinNames.joinToString(", ")}", color = AuntieTheme.colors.textPrimary)
                }
                Text("Status: ${booking.status.name}", color = AuntieTheme.colors.textPrimary)
                Text("Start: ${booking.startDateTime}", color = AuntieTheme.colors.textPrimary)
                Text("End: ${booking.endDateTime}", color = AuntieTheme.colors.textPrimary)

                com.tribetails.auntieos.ui.admin.scheduling.noteCutoffWarning(locked)?.let { msg ->
                    Text(msg, style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.warning)
                }

                Spacer(Modifier.height(4.dp))
                Text("KINFOLK-FACING NOTES", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.kinfolkOrange)
                AuntieField(
                    value         = specialInstructions,
                    onValueChange = { specialInstructions = it },
                    placeholder   = if (locked) "Locked - visit within 3 hours" else "Notes the kinfolk sees on the booking",
                    enabled       = !locked && !isArchived,
                    singleLine    = false,
                    minLines      = 2,
                    modifier      = Modifier.fillMaxWidth(),
                )

                Spacer(Modifier.height(4.dp))
                Text("ADMIN NOTES (INTERNAL)", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.kinfolkOrange)
                AuntieField(
                    value         = notes,
                    onValueChange = { notes = it },
                    placeholder   = "Internal-only - not shown to kinfolk",
                    enabled       = !isArchived,
                    singleLine    = false,
                    minLines      = 2,
                    modifier      = Modifier.fillMaxWidth(),
                )

                if (notesDirty && !isArchived) {
                    PrimaryButton(
                        label    = "Save Notes",
                        onClick  = { onSaveNotes(notes, specialInstructions) },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                // ── Reschedule (real rescheduleBooking write; SCHEDULED visits only) ──
                if (booking.status == BookingStatus.ACCEPTED && !isArchived) {
                    Spacer(Modifier.height(4.dp))
                    Text("RESCHEDULE", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.kinfolkOrange)
                    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        AuntieField(value = reDate, onValueChange = { reDate = it }, label = "Date (YYYY-MM-DD)", modifier = Modifier.weight(1f))
                        AuntieField(value = reTime, onValueChange = { reTime = it }, label = "Time (HH:MM)", modifier = Modifier.weight(1f))
                    }
                    PrimaryButton(
                        label    = "Reschedule visit",
                        onClick  = { onReschedule(reDate, reTime) },
                        enabled  = reDate.length == 10 && reTime.length == 5,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                Spacer(Modifier.height(4.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    if (isArchived) {
                        AuntieTextBtn(onClick = onUnarchive, contentColor = AuntieTheme.colors.kinfolkOrange) {
                            Text("Unarchive")
                        }
                    } else {
                        AuntieTextBtn(onClick = { showArchiveDialog = true }, contentColor = AuntieTheme.colors.warning) {
                            Text("Archive")
                        }
                        Spacer(Modifier.width(4.dp))
                        AuntieTextBtn(onClick = onCancel, contentColor = AuntieTheme.colors.error) {
                            Text("Cancel Booking")
                        }
                    }
                    Spacer(Modifier.width(4.dp))
                    AuntieTextBtn(onClick = onDismiss) { Text("Close") }
                    if (!isArchived) {
                        Spacer(Modifier.width(4.dp))
                        AuntieTextBtn(onClick = onApprove) { Text("Confirm") }
                    }
                }
            }
        }
    }

    if (showArchiveDialog) {
        AuntieModal(
            onDismissRequest = { showArchiveDialog = false; archiveReason = "" },
            title            = "Archive Booking",
            confirmButton    = {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(AuntieTheme.colors.warning)
                        .clickable {
                            onArchive(archiveReason)
                            showArchiveDialog = false
                            archiveReason = ""
                        }
                        .padding(horizontal = 18.dp, vertical = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("Archive", style = AuntieTheme.typography.labelLarge, color = Color.White)
                }
            },
            dismissButton    = {
                AuntieTextBtn(onClick = { showArchiveDialog = false; archiveReason = "" }) { Text("Cancel") }
            },
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Hide this booking from active lists. Reversible - unarchive any time from the booking detail.")
                AuntieField(
                    value         = archiveReason,
                    onValueChange = { archiveReason = it },
                    label         = "Reason (optional)",
                    placeholder   = "e.g. duplicate booking, schedule mistake",
                    singleLine    = false,
                    minLines      = 2,
                )
            }
        }
    }
}

@Composable
fun DayCell(date: LocalDate, events: List<Event>, modifier: Modifier) {
    val isToday = date == LocalDate.now()
    Column(
        modifier = modifier
            .aspectRatio(1f)
            .padding(2.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(if (isToday) AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.2f) else AuntieTheme.colors.surface)
            .clickable { }
            .padding(4.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text(text = date.dayOfMonth.toString(), color = if (isToday) AuntieTheme.colors.kinfolkOrange else AuntieTheme.colors.textPrimary, fontWeight = if (isToday) FontWeight.Bold else FontWeight.Normal)
        if (events.isNotEmpty()) {
            Spacer(Modifier.height(2.dp))
            Box(modifier = Modifier.size(6.dp).clip(CircleShape).background(AuntieTheme.colors.kinfolkOrange))
        }
    }
}

@Composable
fun AgendaView(currentDate: LocalDate, events: List<Event>) {
    val sortedEvents = events.sortedBy { it.startTime }
    if (sortedEvents.isEmpty()) {
        Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            Text("No events scheduled.", color = Color.Gray)
        }
    } else {
        LazyColumn(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            items(sortedEvents) { event ->
                AuntieCard(modifier = Modifier.fillMaxWidth(), containerColor = AuntieTheme.colors.surface2) {
                    Column(modifier = Modifier.padding(16.dp)) {
                        Row(horizontalArrangement = Arrangement.SpaceBetween, modifier = Modifier.fillMaxWidth()) {
                            Text(event.title, fontWeight = FontWeight.Bold, color = AuntieTheme.colors.textPrimary)
                            Text(event.eventType.name, style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.kinfolkOrange)
                        }
                        Spacer(Modifier.height(4.dp))
                        Text(
                            "${event.startTime.format(DateTimeFormatter.ofPattern("MMM dd, h:mm a"))}",
                            style = AuntieTheme.typography.bodyMedium,
                            color = AuntieTheme.colors.textPrimary
                        )
                    }
                }
            }
        }
    }
}

@Composable
fun AddEventDialog(onDismiss: () -> Unit, onAdd: (Event) -> Unit) {
    var title by remember { mutableStateOf("") }

    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        AuntieCard(modifier = Modifier.fillMaxWidth(0.9f), containerColor = AuntieTheme.colors.background) {
            Column(modifier = Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Add Event", style = AuntieTheme.typography.titleLarge, color = AuntieTheme.colors.textPrimary)
                AuntieField(value = title, onValueChange = { title = it }, label = "EVENT TITLE", modifier = Modifier.fillMaxWidth())
                Text("Type: Kin Care / Holiday / Blocked", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    AuntieTextBtn(onClick = onDismiss) { Text("Cancel") }
                    Spacer(Modifier.width(8.dp))
                    PrimaryButton(
                        label   = "Save",
                        onClick = {
                            if (title.isNotBlank()) {
                                onAdd(Event(
                                    id        = System.currentTimeMillis().toString(),
                                    title     = title,
                                    startTime = LocalDateTime.now(),
                                    endTime   = LocalDateTime.now().plusHours(1),
                                    eventType = EventType.KIN_CARE
                                ))
                            }
                        }
                    )
                }
            }
        }
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// Stage 3 / 16.5: one incoming booking envelope (1..N visits). Approve/cancel the
// whole series via manageBookingSeries; approving creates the linked sessions
// server-side so the visits show up on Auntie Time.
// ─────────────────────────────────────────────────────────────────────────────
@Composable
private fun IncomingSeriesRow(
    series: IncomingSeries,
    inFlight: Boolean,
    actionsLocked: Boolean,
    onApprove: () -> Unit,
    onCancel: () -> Unit,
) {
    val c = AuntieTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            text = series.kinfolkName.ifBlank { "Kinfolk request" },
            style = AuntieTheme.typography.titleSmall,
            color = c.textPrimary,
        )
        Text(
            text = buildString {
                append(if (series.visitCount == 1) "1 visit" else "${series.visitCount} visits")
                if (series.isSeries) append(" · recurring series")
                if (series.serviceType.isNotBlank()) append(" · ${series.serviceType}")
            },
            style = AuntieTheme.typography.bodySmall,
            color = c.textDim,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryButton(
                label = if (inFlight) "Working…" else "Approve series",
                onClick = onApprove,
                enabled = !actionsLocked,
            )
            GhostButton(
                label = "Cancel",
                onClick = onCancel,
                enabled = !actionsLocked,
            )
        }
    }
}
