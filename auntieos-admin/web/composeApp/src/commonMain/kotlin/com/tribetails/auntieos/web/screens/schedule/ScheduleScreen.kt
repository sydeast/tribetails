package com.tribetails.auntieos.web.screens.schedule

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.composables.icons.lucide.CalendarPlus
import com.composables.icons.lucide.ChevronLeft
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Plus
import com.tribetails.auntieos.web.data.BookingTimeSlot
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.LocalTestMode
import com.tribetails.auntieos.web.data.TestMode
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.screens.RescheduleArgs
import com.tribetails.auntieos.web.screens.rescheduleArgsForDrop
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieIconButton
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.EmptyHint
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.GlassSurface
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.SegmentedPicker
import com.tribetails.auntieos.web.ui.components.ServicePill
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.ui.components.color
import com.tribetails.auntieos.web.screens.booking.sortServiceTypesByDuration
import com.tribetails.auntieos.web.ui.components.serviceTone
import com.tribetails.auntieos.web.ui.components.statusLabel
import kotlin.time.Clock
import kotlin.time.ExperimentalTime
import kotlin.time.Instant
import kotlinx.datetime.DateTimeUnit
import kotlinx.datetime.LocalDate
import kotlinx.datetime.TimeZone
import kotlinx.coroutines.launch
import kotlinx.datetime.todayIn
import kotlinx.datetime.toLocalDateTime
import kotlinx.datetime.plus
import kotlinx.datetime.isoDayNumber

private enum class ScheduleView(val label: String) {
    Day("Day"),
    Week("Week"),
    Month("Month"),
    SixWeek("6 Wk"),
}

// Week-grid geometry. Mirrors the mockup: a 10-hour window (8a to 6p) at 54px/hour
// inside a fixed-width time gutter. Visit blocks are vertically draggable to a new
// time; the drop snaps to 15-minute slots (rescheduleArgsForDrop default) and calls
// the rescheduleBooking callable.
private const val GRID_START_HOUR = 8
private const val GRID_END_HOUR = 18           // 6p, exclusive bottom edge
private const val GRID_HOURS = GRID_END_HOUR - GRID_START_HOUR
private val HOUR_HEIGHT = 54.dp
private val GUTTER_WIDTH = 56.dp

/**
 * #4: the "Couldn't load busy blocks" banner should appear ONLY when Google
 * Calendar sync is configured (BusinessSettings.calendarSyncId set) AND the
 * busy-blocks stream errored. With no calendar sync there is nothing to load, so
 * a permission/empty error must not surface as a failure to the operator.
 *
 * Stage-0I sandbox: `booking_time_slots` is a GLOBAL calendar-busy collection
 * (not tribe-scoped) that a test admin cannot read at all, yet businessSettings
 * may still resolve a calendarSyncId (guard true), so the banner fired falsely in
 * the sandbox. Suppress it whenever a test admin is signed in — there is no
 * sandbox equivalent to load.
 */
fun shouldShowBusyBlockError(
    calendarSyncConfigured: Boolean,
    busyState: FirestoreResult<*>,
    testMode: TestMode = TestMode.OFF,
): Boolean = calendarSyncConfigured && busyState is FirestoreResult.Error && !testMode.active

@OptIn(ExperimentalTime::class)
@Composable
fun ScheduleScreen() {
    val client = remember { FirestoreClient() }
    val testMode = LocalTestMode.current
    val sessionsState by remember { client.sessionsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val busyState by remember { client.bookingTimeSlotsStream() }.collectAsState(initial = FirestoreResult.Loading)
    // #4: busy blocks (Google Calendar "Busy") only exist once calendar sync is set
    // up (BusinessSettings.calendarSyncId). When it's not configured we must not show
    // the "Couldn't load busy blocks" error, since there is nothing to load.
    val scheduleSettingsState by remember { client.businessSettingsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val scheduleSettings = (scheduleSettingsState as? FirestoreResult.Data)?.value
    val calendarSyncConfigured = (scheduleSettings?.calendarSyncId ?: "").isNotBlank()
    // #9: drag-to-reschedule snaps to 15 min when the operator enabled it, else to
    // minute precision (snap = 1). Default OFF preserves the prior minute-precision drop.
    val dragSnapMinutes = if (scheduleSettings?.snapRescheduleTo15Min == true) 15 else 1

    val localZone = remember { TimeZone.currentSystemDefault() }
    val today = remember { Clock.System.todayIn(localZone) }
    val nowMinutes = remember {
        val t = Clock.System.now().toLocalDateTime(localZone)
        t.hour * 60 + t.minute
    }
    var selected by remember { mutableStateOf<LocalDate?>(today) }
    var viewMode by remember { mutableStateOf(ScheduleView.Week) }
    var selectedSession by remember { mutableStateOf<KinCareSession?>(null) }
    var showBlockTime by remember { mutableStateOf(false) }
    var showNewVisit by remember { mutableStateOf(false) }

    // Drag-to-reschedule (schedule.dragReschedule): optimistic per-session start/end
    // overrides applied to the grid immediately, reverted if rescheduleBooking fails.
    val scope = rememberReportingScope()
    val optimistic = remember { mutableStateMapOf<String, Pair<String, String>>() }
    var rescheduleError by remember { mutableStateOf<String?>(null) }

    fun onRescheduleDrop(args: RescheduleArgs) {
        rescheduleError = null
        val prev = optimistic[args.sessionId]
        optimistic[args.sessionId] = args.startTime to args.endTime // optimistic move
        scope.launch {
            when (val r = client.rescheduleBooking(args.sessionId, args.startTime, args.endTime)) {
                is WriteResult.Ok -> Unit // sessionsStream will confirm the new times
                is WriteResult.Err -> {
                    if (prev == null) optimistic.remove(args.sessionId) else optimistic[args.sessionId] = prev
                    rescheduleError = r.message
                }
            }
        }
    }

    ScreenScaffold {
        // Reframed as a calendar: the label follows the active view + visible range
        // (state/data-driven, not a fixed "this week's runs"). The mislabeled
        // "today's route / active visits / upcoming care windows" subtitle was the
        // clearest mis-framing per spec 13 and now lives on Auntie Time (spec 14),
        // which owns that day-of content. TODO(auntie copy): any final descriptive
        // subtitle wording is author-owned; the range below is data-derived only.
        DenScreenHeading(
            kicker = "The Den · Schedule",
            title = "Schedule",
            accentTail = "${viewMode.label.lowercase()}.",
            subtitle = selected?.let { rangeLabelFor(it, viewMode) },
        )
        Spacer(Modifier.height(20.dp))

        when (val s = sessionsState) {
            FirestoreResult.Loading -> {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    repeat(2) { ShimmerCard(height = 110.dp) }
                }
                return@ScreenScaffold
            }

            is FirestoreResult.Error -> {
                AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    title = "Couldn't load the schedule",
                ) {
                    Text(
                        s.message,
                        style = AuntieTheme.typography.bodyMedium,
                        color = AuntieTheme.colors.textDim,
                    )
                }
                return@ScreenScaffold
            }

            is FirestoreResult.Data -> {
                // Apply any in-flight optimistic reschedule overrides (drag-drop) onto
                // the stream before grouping, so the dragged block jumps to its new slot
                // immediately and reverts cleanly if the callable fails.
                val effectiveSessions = s.value.map { sess ->
                    optimistic[sess._id]?.let { (st, en) -> sess.copy(startTime = st, endTime = en) } ?: sess
                }
                // Group by the LOCAL calendar day of each session's start. Using the
                // local day (not the raw ISO prefix) keeps a UTC-stored start such as
                // "...19:00:00Z" on the correct local-day column.
                val sessionsByDate = effectiveSessions.groupBy { localDateKey(it.startTime, localZone) }
                val selectedKey = selected?.toString().orEmpty()
                val selectedItems = sessionsByDate[selectedKey].orEmpty().sortedBy { it.startTime }
                val agendaLabel = selected?.let(::scheduleAgendaLabel).orEmpty()

                // BLOCKED time slots (Google Calendar busy imports + any other
                // unavailable windows), keyed by their `date` (already a local
                // YYYY-MM-DD on the doc). The grid draws these as read-only "Busy"
                // overlays. Drawn on parity with Android (filter !isAvailable).
                val busySlotsByDate = blockedSlotsByDate(
                    (busyState as? FirestoreResult.Data)?.value.orEmpty()
                )

                // ── Controls: week nav, view picker, gated New-visit CTA ──
                ScheduleControls(
                    rangeLabel = selected?.let { rangeLabelFor(it, viewMode) }.orEmpty(),
                    viewMode = viewMode,
                    onBlockTime = { showBlockTime = true },
                    onNewVisit = { showNewVisit = true },
                    onViewChange = { viewMode = it },
                    onPrev = { selected = selected?.let { shiftRange(it, viewMode, -1) } },
                    onNext = { selected = selected?.let { shiftRange(it, viewMode, +1) } },
                )

                // #575: this comment described a "New visit" button that was not
                // here. `NewVisitDialog` existed, called the deployed
                // createKinCareSession callable, and NOTHING opened it - so the
                // admin-direct schedule path was documented on a screen that could
                // not reach it. The button below the range navigator is that entry
                // point, now real. It is distinct from the Bookings *request* flow:
                // this writes a SCHEDULED visit straight onto the calendar rather
                // than filing a request that needs approving.

                // Google Calendar "Busy" blocks are written server-side to
                // booking_time_slots by syncGoogleCalendarBusyEvents and drawn on the
                // week grid below (read-only, no event detail). Surface a load error
                // loud ONLY when calendar sync is actually configured (#4): without
                // setup there is nothing to load, so the banner would be noise.
                if (shouldShowBusyBlockError(calendarSyncConfigured, busyState, testMode)) {
                    Spacer(Modifier.height(10.dp))
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        title = "Couldn't load busy blocks",
                    ) {
                        Text(
                            (busyState as FirestoreResult.Error).message,
                            style = AuntieTheme.typography.bodyMedium,
                            color = AuntieTheme.colors.textDim,
                        )
                    }
                }

                Spacer(Modifier.height(14.dp))
                // B9: order by parsed duration, not the scrambled Map order. The
                // 06-24 pass fixed this on BookingScreen and android and marked it
                // "ANDROID PARITY COMPLETE" while this call site still passed raw
                // keys, so the web legend read 90Minute, 60Minute, 30Minute, 2Hrs.
                ScheduleLegend(
                    serviceTypes = sortServiceTypesByDuration(
                        scheduleSettings?.serviceRates?.keys?.toList().orEmpty(),
                    ),
                )
                Spacer(Modifier.height(14.dp))

                // #12: day detail above the calendar so the small card is seen first,
                // not folded below the dominant grid.
                DenPanel(
                    title = agendaLabel.ifBlank { "Day agenda" },
                    subtitle = "Tap a visit to open its booking detail and notes.",
                ) {
                    DayAgenda(
                        selected = selected,
                        sessions = selectedItems,
                        localZone = localZone,
                        onSessionClick = { selectedSession = it },
                    )
                }
                Spacer(Modifier.height(18.dp))

                when (viewMode) {
                    ScheduleView.Day -> { /* day view: the agenda above is the detail */ }
                    ScheduleView.Week -> GlassSurface(cornerRadius = 22.dp) {
                        WeekCalendar(
                            days = selected?.let(::weekStripDays).orEmpty(),
                            today = today,
                            nowMinutes = nowMinutes,
                            localZone = localZone,
                            sessionsByDate = sessionsByDate,
                            busySlotsByDate = busySlotsByDate,
                            onSessionClick = { selectedSession = it },
                            onSelectDay = { selected = it },
                            onReschedule = ::onRescheduleDrop,
                            snapMinutes = dragSnapMinutes,
                        )
                    }
                    ScheduleView.Month -> GlassSurface(cornerRadius = 18.dp) {
                        MonthGrid(
                            anchor = selected ?: today,
                            weeks = 5,
                            selected = selected,
                            countFor = { day -> sessionsByDate[day.toString()].orEmpty().size },
                            onSelect = { selected = it },
                        )
                    }
                    ScheduleView.SixWeek -> GlassSurface(cornerRadius = 18.dp) {
                        MonthGrid(
                            anchor = selected ?: today,
                            weeks = 6,
                            selected = selected,
                            countFor = { day -> sessionsByDate[day.toString()].orEmpty().size },
                            onSelect = { selected = it },
                        )
                    }
                }

                // Drag-to-reschedule is WIRED: drag a week-grid visit block vertically
                // to a new time, drop to call rescheduleBooking. Surface any failure
                // (optimistic move reverts) loud in the banner below.
                rescheduleError?.let { msg ->
                    Spacer(Modifier.height(10.dp))
                    AuntieBanner(
                        tone = AuntieBannerTone.Error,
                        title = "Couldn't reschedule that visit",
                    ) {
                        Text(
                            msg,
                            style = AuntieTheme.typography.bodyMedium,
                            color = AuntieTheme.colors.textDim,
                        )
                    }
                }
            }
        }
    }

    selectedSession?.let { sess ->
        BookingDetailModal(
            session = sess,
            onDismiss = { selectedSession = null },
            client = client,
        )
    }

    if (showNewVisit) {
        NewVisitDialog(
            client = client,
            localZone = localZone,
            onDismiss = { showNewVisit = false },
            onCreated = { showNewVisit = false }, // the sessions stream re-renders the grid
        )
    }
    if (showBlockTime) {
        // B6: operator replaced the admin-direct "New Visit" create here with blocking
        // an unavailable window. Admins create visits via Bookings; this blocks time off.
        BlockTimeDialog(
            client = client,
            today = today,
            onDismiss = { showBlockTime = false },
            onCreated = { showBlockTime = false }, // busy-slots stream re-renders the grid
        )
    }
}

@Composable
private fun ScheduleControls(
    rangeLabel: String,
    viewMode: ScheduleView,
    onBlockTime: () -> Unit,
    onNewVisit: () -> Unit,
    onViewChange: (ScheduleView) -> Unit,
    onPrev: () -> Unit,
    onNext: () -> Unit,
) {
    FlowRowControls(
        rangeLabel = rangeLabel,
        viewMode = viewMode,
        onBlockTime = onBlockTime,
        onNewVisit = onNewVisit,
        onViewChange = onViewChange,
        onPrev = onPrev,
        onNext = onNext,
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun FlowRowControls(
    rangeLabel: String,
    viewMode: ScheduleView,
    onBlockTime: () -> Unit,
    onNewVisit: () -> Unit,
    onViewChange: (ScheduleView) -> Unit,
    onPrev: () -> Unit,
    onNext: () -> Unit,
) {
    val c = AuntieTheme.colors
    FlowRow(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        // Week navigator: ‹  May 25 to 31  ›
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(13.dp))
                .background(c.surface2)
                .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(13.dp))
                .padding(horizontal = 5.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            AuntieIconButton(
                icon = Lucide.ChevronLeft,
                contentDescription = "Previous",
                onClick = onPrev,
                size = 32.dp,
            )
            Text(
                text = rangeLabel,
                style = AuntieTheme.typography.mono.copy(fontSize = 12.5.sp),
                color = c.textPrimary,
                modifier = Modifier
                    .width(132.dp)
                    .padding(horizontal = 4.dp),
            )
            AuntieIconButton(
                icon = Lucide.ChevronRight,
                contentDescription = "Next",
                onClick = onNext,
                size = 32.dp,
            )
        }

        SegmentedPicker(
            options = listOf(ScheduleView.Day, ScheduleView.Week, ScheduleView.Month, ScheduleView.SixWeek),
            selected = viewMode,
            onSelect = onViewChange,
            label = { it.label },
        )

        // #575: the admin-direct "put a visit on the calendar" path. `NewVisitDialog`
        // and the `createKinCareSession` callable behind it have both been here the
        // whole time; this screen simply never offered a way in, while a comment above
        // said it did. Ghost rather than primary because Block time is the action this
        // screen leads with, and the React admin makes the same pairing.
        GhostButton(label = "New visit", onClick = onNewVisit)
        // B6: blocks an unavailable window.
        PrimaryButton(
            label = "Block time",
            onClick = onBlockTime,
            leading = {
                AuntieIconButton(
                    icon = Lucide.Plus,
                    contentDescription = "Block time",
                    onClick = onBlockTime,
                    size = 18.dp,
                )
            },
        )
    }
}

/**
 * Service-type color legend from the mockup. Swatch colors are derived from the
 * shared [serviceTone] mapping so the key matches what the grid actually paints.
 * The "Busy" entry matches the muted overlays drawn for BLOCKED booking_time_slots
 * (Google Calendar busy imports written server-side by syncGoogleCalendarBusyEvents).
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
        // B7: render the auntie's REAL service types (Business Settings serviceRates),
        // not hardcoded demo names, using the same serviceTone the grid paints with so
        // the key always matches what's on the calendar.
        serviceTypes.forEach { type ->
            LegendItem(serviceTone(type).color(c), type)
        }
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

/**
 * Week calendar grid (mockup centerpiece): a time gutter (8a to 6p) plus 7 day
 * columns, with real sessions positioned by their LOCAL start time. Today's column
 * is tinted and carries a coral "now" line. Tapping a day header selects it; tapping
 * an event opens the booking detail modal; dragging an event vertically reschedules it.
 *
 * Sessions whose local start falls outside the 8a to 6p window are NOT clamped onto
 * the grid edge (which would fabricate a wrong position). They are counted and the
 * total surfaced as an honest off-window note; the full list still appears in the
 * day agenda below the grid.
 */
@Composable
private fun WeekCalendar(
    days: List<LocalDate>,
    today: LocalDate,
    nowMinutes: Int,
    localZone: TimeZone,
    sessionsByDate: Map<String, List<KinCareSession>>,
    busySlotsByDate: Map<String, List<BookingTimeSlot>>,
    onSessionClick: (KinCareSession) -> Unit,
    onSelectDay: (LocalDate) -> Unit,
    onReschedule: (RescheduleArgs) -> Unit,
    snapMinutes: Int,
) {
    val c = AuntieTheme.colors
    if (days.isEmpty()) return

    val windowStart = GRID_START_HOUR * 60
    val windowEnd = GRID_END_HOUR * 60
    var offWindowCount = 0
    var placeableCount = 0
    days.forEach { day ->
        sessionsByDate[day.toString()].orEmpty().forEach { sess ->
            val m = localMinutesOfDay(sess.startTime, localZone)
            if (m == null || m < windowStart || m >= windowEnd) offWindowCount++ else placeableCount++
        }
    }

    // Fill-width week grid (spec 13 item 3): the 7 day columns flex (weight 1f) to
    // fill the container beside the fixed time gutter, matching the mock's
    // `grid-template-columns:56px repeat(7,1fr)`. No horizontal scroll on wide
    // viewports; the ScreenScaffold centers the grid within its max width.
    // Outer column keeps the grid and the empty/off-window note in a single vertical
    // flow (nesting the note avoids the GlassSurface Box overlap bug).
    Column(modifier = Modifier.fillMaxWidth()) {
    Column(modifier = Modifier.fillMaxWidth()) {
        // ── Day header row ──
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .border(AuntieTheme.dims.borderHairline, Color.Transparent),
        ) {
            Spacer(Modifier.width(GUTTER_WIDTH))
            days.forEach { day ->
                val isToday = day == today
                Column(
                    modifier = Modifier
                        .weight(1f)
                        .clickable(
                            interactionSource = remember { MutableInteractionSource() },
                            indication = null,
                        ) { onSelectDay(day) }
                        .padding(vertical = 13.dp, horizontal = 10.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(3.dp),
                ) {
                    Text(
                        text = day.dayOfWeek.name.take(3).lowercase().replaceFirstChar(Char::titlecase),
                        style = AuntieTheme.typography.mono.copy(fontSize = 10.5.sp, letterSpacing = 1.sp),
                        color = if (isToday) c.coral else c.textFaint,
                    )
                    if (isToday) {
                        Box(
                            modifier = Modifier
                                .size(34.dp)
                                .clip(RoundedCornerShape(11.dp))
                                .background(c.coral),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                text = day.day.toString(),
                                style = AuntieTheme.typography.headlineSmall,
                                color = c.textPrimary,
                            )
                        }
                    } else {
                        Text(
                            text = day.day.toString(),
                            style = AuntieTheme.typography.headlineSmall,
                            color = c.textPrimary,
                        )
                    }
                }
            }
        }

        Box(
            modifier = Modifier
                .height(AuntieTheme.dims.borderHairline)
                .fillMaxWidth()
                .background(c.border),
        )

        // ── Body grid: time gutter + day columns ──
        Box {
            Row(modifier = Modifier.fillMaxWidth()) {
                // Time gutter
                Column(modifier = Modifier.width(GUTTER_WIDTH)) {
                    repeat(GRID_HOURS) { i ->
                        Box(
                            modifier = Modifier
                                .height(HOUR_HEIGHT)
                                .fillMaxWidth(),
                        ) {
                            Text(
                                text = hourLabel(GRID_START_HOUR + i),
                                style = AuntieTheme.typography.mono.copy(fontSize = 10.5.sp),
                                color = c.textFaint,
                                modifier = Modifier
                                    .align(Alignment.TopEnd)
                                    .padding(end = 8.dp),
                            )
                        }
                    }
                }

                days.forEach { day ->
                    val isToday = day == today
                    val daySessions = sessionsByDate[day.toString()].orEmpty()
                    val dayBusy = busySlotsByDate[day.toString()].orEmpty()
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .height(HOUR_HEIGHT * GRID_HOURS)
                            .background(if (isToday) c.coral.copy(alpha = 0.05f) else Color.Transparent)
                            .border(AuntieTheme.dims.borderHairline, c.borderSoft),
                    ) {
                        // Hour gridlines
                        repeat(GRID_HOURS) { i ->
                            Box(
                                modifier = Modifier
                                    .padding(top = HOUR_HEIGHT * (i + 1) - AuntieTheme.dims.borderHairline)
                                    .height(AuntieTheme.dims.borderHairline)
                                    .fillMaxWidth()
                                    .background(c.borderSoft),
                            )
                        }
                        // Busy overlays drawn UNDER the real visits: read-only, no event
                        // detail (hideDetailsFromKinfolk=true and the slot carries no
                        // title), just a generic "Busy" band. Off-window slots drop out.
                        dayBusy.forEach { slot -> BusyBlock(slot = slot) }
                        // Event blocks (only in-window sessions are positioned here).
                        // Each is vertically draggable to a new time slot; the drop maps
                        // to rescheduleBooking via rescheduleArgsForDrop.
                        daySessions.forEach { session ->
                            EventBlock(
                                snapMinutes = snapMinutes,
                                session = session,
                                dayIso = day.toString(),
                                localZone = localZone,
                                onClick = { onSessionClick(session) },
                                onReschedule = onReschedule,
                            )
                        }
                    }
                }
            }

            // ── "now" line, only when today is in the visible week ──
            if (days.contains(today) && nowMinutes in windowStart..windowEnd) {
                val topOffset = HOUR_HEIGHT * ((nowMinutes - windowStart) / 60f)
                Box(
                    modifier = Modifier
                        .padding(start = GUTTER_WIDTH, top = topOffset)
                        .fillMaxWidth(),
                ) {
                    Box(
                        modifier = Modifier
                            .height(2.dp)
                            .fillMaxWidth()
                            .background(c.coral),
                    )
                    Box(
                        modifier = Modifier
                            .offset(x = 6.dp, y = (-19).dp)
                            .clip(RoundedCornerShape(6.dp))
                            .background(c.background)
                            .padding(horizontal = 6.dp, vertical = 1.dp),
                    ) {
                        Text(
                            text = "now ${hourMinuteLabel(nowMinutes)}",
                            style = AuntieTheme.typography.mono.copy(fontSize = 9.5.sp),
                            color = c.coral,
                        )
                    }
                }
            }
        }
    }

    // Honest off-window note: visits outside 8a to 6p are not drawn on the grid (no
    // fabricated edge position). They still appear in the agenda below.
    if (offWindowCount > 0) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Text(
                text = "$offWindowCount visit${if (offWindowCount == 1) "" else "s"} outside the ${hourLabel(GRID_START_HOUR)} to ${hourLabel(GRID_END_HOUR)} window. Open a day below to see all of its visits.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
        }
    } else if (placeableCount == 0) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
        ) {
            Text(
                text = "No visits scheduled this week. Step the week navigator to find upcoming runs.",
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
        }
    }
    }
}

@Composable
private fun EventBlock(
    session: KinCareSession,
    dayIso: String,
    localZone: TimeZone,
    onClick: () -> Unit,
    onReschedule: (RescheduleArgs) -> Unit,
    snapMinutes: Int,
) {
    val c = AuntieTheme.colors
    val accent = serviceTint(session.serviceType, session.status)

    val startMin = localMinutesOfDay(session.startTime, localZone)
    if (startMin == null) return // unparseable: don't fabricate a position

    val windowStart = GRID_START_HOUR * 60
    val windowEnd = GRID_END_HOUR * 60
    // Off-window: do NOT clamp onto the grid edge (that mispositions the block).
    // Drop it from the grid; the day agenda still lists it.
    if (startMin < windowStart || startMin >= windowEnd) return

    // Room remaining to the bottom edge (1..600). A visit starting in the last few
    // minutes of the window has under 20 min of room, so the visible minimum is
    // capped by that room: coerceIn(min, max) with min > max would throw.
    val roomToBottom = windowEnd - startMin
    val minVisible = minOf(20, roomToBottom)
    val rawDuration = when {
        session.serviceDurationMinutes > 0 -> session.serviceDurationMinutes
        else -> localMinutesOfDay(session.endTime, localZone)?.let { it - startMin } ?: 30
    }
    val durationMin = rawDuration.coerceIn(minVisible, roomToBottom)

    val top = HOUR_HEIGHT * ((startMin - windowStart) / 60f)
    val blockHeight = HOUR_HEIGHT * (durationMin / 60f)

    // Live vertical drag offset (px). On drop, convert px -> minutes via the
    // grid scale (HOUR_HEIGHT px == 60 min) and map to rescheduleBooking args.
    val density = LocalDensity.current
    val hourPx = with(density) { HOUR_HEIGHT.toPx() }
    var dragOffsetPx by remember(session._id, session.startTime) { mutableStateOf(0f) }

    Column(
        modifier = Modifier
            .padding(top = top, start = 5.dp, end = 5.dp)
            .offset { IntOffset(0, dragOffsetPx.toInt()) }
            .fillMaxWidth()
            .height(blockHeight)
            .clip(RoundedCornerShape(11.dp))
            .background(accent.copy(alpha = if (c.isDark) 0.17f else 0.12f).compositeOver(c.surface))
            .border(AuntieTheme.dims.borderHairline, accent.copy(alpha = 0.5f), RoundedCornerShape(11.dp))
            .pointerInput(session._id, startMin, durationMin, dayIso) {
                detectDragGestures(
                    onDragEnd = {
                        val deltaMin = (dragOffsetPx / hourPx * 60f).toInt()
                        dragOffsetPx = 0f
                        if (deltaMin == 0) return@detectDragGestures
                        val newStart = (startMin + deltaMin).coerceIn(windowStart, windowEnd - 1)
                        rescheduleArgsForDrop(
                            session = session,
                            targetDateIso = dayIso,
                            dropMinuteOfDay = newStart,
                            snapMinutes = snapMinutes,
                        )?.let(onReschedule)
                    },
                    onDragCancel = { dragOffsetPx = 0f },
                ) { change, dragAmount ->
                    change.consume()
                    dragOffsetPx += dragAmount.y
                }
            }
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = 9.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(
            text = displayTime(session.startTime, localZone),
            style = AuntieTheme.typography.mono.copy(fontSize = 9.5.sp),
            color = accent,
        )
        Text(
            text = session.kinfolkName.ifBlank { session.serviceType.ifBlank { "Kin Care Visit" } },
            style = AuntieTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold),
            color = c.textPrimary,
            maxLines = 1,
        )
        if (blockHeight >= 56.dp && session.serviceType.isNotBlank()) {
            Text(
                text = session.serviceType,
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
                maxLines = 1,
            )
        }
    }
}

/**
 * Read-only "Busy" overlay for a BLOCKED [BookingTimeSlot] (Google Calendar busy
 * import or any other unavailable window). Drawn as a muted hatched band in the day
 * column. Deliberately shows NO event detail: the slot has hideDetailsFromKinfolk
 * set and carries no title, so only a generic "Busy" label is shown. Not clickable;
 * off-window or unparseable slots drop out (no fabricated edge position), matching
 * how [EventBlock] handles off-window visits.
 */
@Composable
private fun BusyBlock(slot: BookingTimeSlot) {
    val c = AuntieTheme.colors
    val placement = busyPlacement(slot.startTime, slot.endTime) ?: return
    val top = HOUR_HEIGHT * (placement.topMinutes / 60f)
    val blockHeight = HOUR_HEIGHT * (placement.heightMinutes / 60f)

    Column(
        modifier = Modifier
            .padding(top = top, start = 5.dp, end = 5.dp)
            .fillMaxWidth()
            .height(blockHeight)
            .clip(RoundedCornerShape(11.dp))
            .background(c.textFaint.copy(alpha = if (c.isDark) 0.18f else 0.12f).compositeOver(c.surface))
            .border(AuntieTheme.dims.borderHairline, c.textFaint.copy(alpha = 0.45f), RoundedCornerShape(11.dp))
            .padding(horizontal = 9.dp, vertical = 6.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(
            text = "Busy",
            style = AuntieTheme.typography.titleSmall.copy(fontWeight = FontWeight.Bold),
            color = c.textDim,
            maxLines = 1,
        )
    }
}

@Composable
private fun MonthGrid(
    anchor: LocalDate,
    weeks: Int,
    selected: LocalDate?,
    countFor: (LocalDate) -> Int,
    onSelect: (LocalDate) -> Unit,
) {
    val c = AuntieTheme.colors
    // Start grid on Monday of the week containing the 1st of anchor's month.
    val firstOfMonth = LocalDate(anchor.year, anchor.month, 1)
    val gridStart = firstOfMonth.plus(-(firstOfMonth.dayOfWeek.isoDayNumber - 1), DateTimeUnit.DAY)
    val days = List(weeks * 7) { idx -> gridStart.plus(idx, DateTimeUnit.DAY) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 12.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        // Day-of-week header
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
            listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun").forEach { d ->
                Text(
                    d,
                    style = AuntieTheme.typography.labelSmall,
                    color = c.textFaint,
                    modifier = Modifier.weight(1f),
                )
            }
        }
        days.chunked(7).forEach { week ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
                week.forEach { day ->
                    val daySelected = selected == day
                    val inMonth = day.month == anchor.month
                    val count = countFor(day)
                    Column(
                        modifier = Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(8.dp))
                            .background(if (daySelected) c.primary.copy(alpha = 0.12f).compositeOver(c.surface) else Color.Transparent)
                            .border(AuntieTheme.dims.borderHairline, if (daySelected) c.primary.copy(alpha = 0.5f) else c.borderSoft, RoundedCornerShape(8.dp))
                            .clickable { onSelect(day) }
                            .padding(vertical = 6.dp, horizontal = 4.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        Text(
                            day.day.toString(),
                            style = AuntieTheme.typography.bodyMedium,
                            color = when {
                                daySelected -> c.primary
                                !inMonth -> c.textFaint
                                else -> c.textPrimary
                            },
                        )
                        if (count > 0) {
                            Box(
                                modifier = Modifier
                                    .clip(RoundedCornerShape(999.dp))
                                    .background(c.primary.copy(alpha = 0.16f).compositeOver(c.surface))
                                    .padding(horizontal = 5.dp, vertical = 1.dp),
                            ) {
                                Text("$count", style = AuntieTheme.typography.labelSmall, color = c.primary)
                            }
                        } else {
                            Spacer(Modifier.height(8.dp))
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DayAgenda(
    selected: LocalDate?,
    sessions: List<KinCareSession>,
    localZone: TimeZone,
    onSessionClick: (KinCareSession) -> Unit = {},
) {
    val c = AuntieTheme.colors

    if (sessions.isEmpty()) {
        EmptyHint(
            text = if (selected == null) "Select a day to inspect bookings."
            else "No Kin Care sessions on this day.",
        )
        return
    }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        sessions.forEach { session ->
            val accent = serviceTint(session.serviceType, session.status)

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(18.dp))
                    .background(c.surfaceGlass)
                    .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(18.dp))
                    .clickable { onSessionClick(session) }
                    .padding(12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    modifier = Modifier
                        .width(4.dp)
                        .fillMaxHeight()
                        .clip(RoundedCornerShape(999.dp))
                        .background(accent),
                )

                Text(
                    text = displayTime(session.startTime, localZone),
                    style = AuntieTheme.typography.titleLarge,
                    color = c.textPrimary,
                )

                Box(
                    modifier = Modifier
                        .width(1.dp)
                        .height(64.dp)
                        .background(c.borderSoft),
                )

                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = session.serviceType.ifBlank { "Kin Care Visit" },
                            style = AuntieTheme.typography.titleLarge,
                            color = c.textPrimary,
                        )
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            ServicePill(session.serviceType, serviceTone(session.serviceType))
                            AuntieStatusPill(
                                label = statusBadge(session.status),
                                tone = statusTone(session.status),
                                showDot = true,
                            )
                        }
                    }
                    Text(
                        text = scheduleSubtitle(session),
                        style = AuntieTheme.typography.bodyMedium,
                        color = c.textDim,
                    )
                }
            }
        }
    }
}

/**
 * Pure helper: filter a raw booking_time_slots list down to the BLOCKED slots
 * (isAvailable == false, mirroring Android's `timeSlots.filter { !it.isAvailable }`)
 * and group them by their `date` (local YYYY-MM-DD on the doc). Slots with a blank
 * date are dropped (they can't be placed on a day column). Within each day the
 * blocks are sorted by start time for a stable draw order.
 */
internal fun blockedSlotsByDate(slots: List<BookingTimeSlot>): Map<String, List<BookingTimeSlot>> =
    slots
        .filter { !it.isAvailable && it.date.isNotBlank() }
        .groupBy { it.date }
        .mapValues { (_, daySlots) -> daySlots.sortedBy { it.startTime } }

/** Vertical placement (in minutes from the grid window top) for a busy block. */
internal data class BusyPlacement(val topMinutes: Int, val heightMinutes: Int)

/**
 * Pure helper: resolve where a busy block sits in the 8a to 6p week-grid window
 * from its "HH:mm" start/end. Returns null when the start is unparseable or falls
 * outside the window (no fabricated edge position). A missing/zero-length end is
 * given a small visible minimum, clamped so the block never overruns the window
 * bottom. Mirrors [EventBlock]'s off-window/min-height handling.
 */
internal fun busyPlacement(startHHmm: String, endHHmm: String): BusyPlacement? {
    val windowStart = GRID_START_HOUR * 60
    val windowEnd = GRID_END_HOUR * 60
    val startMin = hhmmToMinutes(startHHmm) ?: return null
    if (startMin < windowStart || startMin >= windowEnd) return null

    val roomToBottom = windowEnd - startMin
    val minVisible = minOf(20, roomToBottom)
    val endMin = hhmmToMinutes(endHHmm)
    val rawDuration = if (endMin != null && endMin > startMin) endMin - startMin else minVisible
    val duration = rawDuration.coerceIn(minVisible, roomToBottom)
    return BusyPlacement(topMinutes = startMin - windowStart, heightMinutes = duration)
}

/** "HH:mm" to minutes-from-midnight, or null if unparseable. */
internal fun hhmmToMinutes(hhmm: String): Int? = runCatching {
    if (hhmm.length < 4 || hhmm[2] != ':') return@runCatching null
    val hour = hhmm.substring(0, 2).toInt()
    val minute = hhmm.substring(3, 5).toInt()
    if (hour !in 0..23 || minute !in 0..59) return@runCatching null
    hour * 60 + minute
}.getOrNull()

private fun weekStripDays(selected: LocalDate): List<LocalDate> {
    val monday = selected.plus(-(selected.dayOfWeek.isoDayNumber - 1), DateTimeUnit.DAY)
    return List(7) { idx -> monday.plus(idx, DateTimeUnit.DAY) }
}

private fun scheduleAgendaLabel(selected: LocalDate): String {
    val day = selected.dayOfWeek.name.lowercase().replaceFirstChar(Char::titlecase)
    val month = selected.month.name.lowercase().replaceFirstChar(Char::titlecase)
    return "$day, $month ${selected.day}"
}

/** Range label for the week-nav, scoped to the active view. */
private fun rangeLabelFor(selected: LocalDate, view: ScheduleView): String = when (view) {
    ScheduleView.Day -> {
        val month = monthAbbrev(selected)
        "$month ${selected.day}"
    }
    ScheduleView.Week -> {
        val week = weekStripDays(selected)
        val start = week.first()
        val end = week.last()
        if (start.month == end.month) {
            "${monthAbbrev(start)} ${start.day} to ${end.day}"
        } else {
            "${monthAbbrev(start)} ${start.day} to ${monthAbbrev(end)} ${end.day}"
        }
    }
    ScheduleView.Month, ScheduleView.SixWeek -> {
        val month = selected.month.name.lowercase().replaceFirstChar(Char::titlecase)
        "$month ${selected.year}"
    }
}

/** Step the selection forward/backward by one unit of the active view. */
private fun shiftRange(selected: LocalDate, view: ScheduleView, direction: Int): LocalDate = when (view) {
    ScheduleView.Day -> selected.plus(direction.toLong(), DateTimeUnit.DAY)
    ScheduleView.Week -> selected.plus((7 * direction).toLong(), DateTimeUnit.DAY)
    ScheduleView.Month, ScheduleView.SixWeek -> selected.plus(direction.toLong(), DateTimeUnit.MONTH)
}

private fun monthAbbrev(date: LocalDate): String =
    date.month.name.take(3).lowercase().replaceFirstChar(Char::titlecase)

/**
 * Service-type color, resolved through the shared [serviceTone] mapping (the same
 * key the rest of the Den uses), so the legend, pills, and grid blocks all agree.
 * Cancelled visits fade to faint. Free-text keys with no match (e.g. "visit_60")
 * resolve to Orange via [serviceTone], which is what the legend's "Other /
 * unmapped" swatch shows.
 *
 * That last sentence was FALSE from 2026-06-01 to 2026-07-15 and is the reason
 * AO-19 lived 44 days: [serviceTone] matched "sit" as a bare substring, so
 * "vi-SIT-_60" resolved to Purple, not Orange. Two later review passes read this
 * comment, believed it, and moved on. It is now enforced by
 * DenScreenKitTest.serviceTone_does_not_match_sit_inside_visit rather than
 * asserted here. If you change [serviceTone], that test is the contract.
 */
@Composable
private fun serviceTint(serviceType: String, status: String): Color {
    val c = AuntieTheme.colors
    if (status.uppercase() == "CANCELLED") return c.textFaint
    return serviceTone(serviceType).color(c)
}

private fun statusTone(status: String): AuntieStatusTone = when (status.uppercase()) {
    "ON_MY_WAY" -> AuntieStatusTone.Warning
    "ARRIVED", "DEPARTED" -> AuntieStatusTone.Orange
    "COMPLETED" -> AuntieStatusTone.Success
    "CANCELLED" -> AuntieStatusTone.Muted
    else -> AuntieStatusTone.Neutral
}

private fun statusBadge(status: String): String = when (status.uppercase()) {
    "COMPLETED" -> "COMPLETED"
    "ON_MY_WAY", "ARRIVED", "DEPARTED" -> "ACTIVE"
    "SCHEDULED" -> "CONFIRMED"
    "CANCELLED" -> "CANCELLED"
    else -> status.uppercase()
}

private fun scheduleSubtitle(session: KinCareSession): String {
    val who = session.kinfolkName.ifBlank { "Kinfolk" }
    val duration = if (session.serviceDurationMinutes > 0) ", ${session.serviceDurationMinutes} mins" else ""
    val phase = statusLabel(session.status)
    return "$who$duration · $phase"
}

/**
 * The LOCAL calendar day (YYYY-MM-DD) for an ISO timestamp, converting from the
 * stored zone (UTC "...Z" or offset) to the auntie's local zone. Falls back to the
 * raw 10-char ISO prefix only when the string can't be parsed as an instant (so a
 * timezone-less local string still groups by its literal date).
 */
@OptIn(ExperimentalTime::class)
private fun localDateKey(iso: String, zone: TimeZone): String {
    val ldt = parseToLocal(iso, zone)
    if (ldt != null) return ldt.date.toString()
    return if (iso.length >= 10) iso.substring(0, 10) else iso
}

/** Local minutes-from-midnight for an ISO instant, or null if unparseable. */
@OptIn(ExperimentalTime::class)
private fun localMinutesOfDay(iso: String, zone: TimeZone): Int? {
    val ldt = parseToLocal(iso, zone) ?: return positionalMinutes(iso)
    return ldt.hour * 60 + ldt.minute
}

/** Parse an ISO-8601 instant (with Z/offset) into a local-zone date-time, or null. */
@OptIn(ExperimentalTime::class)
private fun parseToLocal(iso: String, zone: TimeZone) = runCatching {
    Instant.parse(iso).toLocalDateTime(zone)
}.getOrNull()

/**
 * Fallback minutes-of-day for a timezone-less local ISO ("YYYY-MM-DDTHH:MM..."),
 * read positionally. Only used when [Instant.parse] fails (no Z/offset present).
 */
private fun positionalMinutes(iso: String): Int? = runCatching {
    if (iso.length < 16) return@runCatching null
    val hour = iso.substring(11, 13).toInt()
    val minute = iso.substring(14, 16).toInt()
    hour * 60 + minute
}.getOrNull()

/** Compact hour label for the time gutter (8a, 12p, 1p). */
private fun hourLabel(hour24: Int): String {
    val ap = if (hour24 < 12) "a" else "p"
    val h = hour24 % 12
    val hh = if (h == 0) 12 else h
    return "$hh$ap"
}

private fun hourMinuteLabel(minutes: Int): String {
    val h = minutes / 60
    val m = minutes % 60
    val hh = h % 12
    val h12 = if (hh == 0) 12 else hh
    return "$h12:${m.toString().padStart(2, '0')}"
}

/**
 * Display time in the auntie's LOCAL zone. Converts a UTC/offset ISO instant to
 * local before formatting, so a "...19:00:00Z" start reads as the correct local
 * hour, not the literal UTC hour. Falls back to positional formatting for a
 * timezone-less local string, and finally echoes the raw input.
 */
@OptIn(ExperimentalTime::class)
private fun displayTime(iso: String, zone: TimeZone): String {
    val ldt = parseToLocal(iso, zone)
    if (ldt != null) {
        val ampm = if (ldt.hour >= 12) "PM" else "AM"
        val hour12 = when (ldt.hour % 12) { 0 -> 12; else -> ldt.hour % 12 }
        return "$hour12:${ldt.minute.toString().padStart(2, '0')} $ampm"
    }
    return runCatching {
        if (iso.length < 16) return@runCatching iso
        val hour = iso.substring(11, 13).toInt()
        val minute = iso.substring(14, 16)
        val ampm = if (hour >= 12) "PM" else "AM"
        val hour12 = when (hour % 12) { 0 -> 12; else -> hour % 12 }
        "$hour12:$minute $ampm"
    }.getOrDefault(iso)
}
