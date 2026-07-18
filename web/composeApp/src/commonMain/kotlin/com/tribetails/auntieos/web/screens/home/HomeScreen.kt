package com.tribetails.auntieos.web.screens.home

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
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import com.tribetails.auntieos.web.observability.rememberReportingScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import androidx.compose.ui.Alignment
import kotlin.math.roundToInt
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.composables.icons.lucide.ArrowDown
import com.composables.icons.lucide.ArrowUp
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Eye
import com.composables.icons.lucide.EyeOff
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.PawPrint
import com.composables.icons.lucide.Pencil
import com.composables.icons.lucide.SlidersHorizontal
import com.tribetails.auntieos.web.branding.homeHeading
import com.tribetails.auntieos.web.data.AuthUser
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.UserProfile
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.screens.inbox.ConversationSummary
import com.tribetails.auntieos.web.data.GeneratedDraft
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.screens.invoices.formatMoney
import com.tribetails.auntieos.web.screens.weeklyRevenue
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieIconButton
import com.tribetails.auntieos.web.ui.components.AuntieIconTile
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.DashRevealItem
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.PulsingBadge
import com.tribetails.auntieos.web.ui.components.color
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.EmptyHint
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.ServicePill
import com.tribetails.auntieos.web.ui.components.StatCard
import com.tribetails.auntieos.web.ui.components.denCurrentHour
import com.tribetails.auntieos.web.ui.components.formatTime
import com.tribetails.auntieos.web.ui.components.greetingForHour
import com.tribetails.auntieos.web.ui.components.serviceTone
import com.tribetails.auntieos.web.ui.components.statusLabel
import com.tribetails.auntieos.web.ui.shell.Destination
import com.tribetails.auntieos.web.util.nowIso
import kotlin.time.Clock
import kotlin.time.ExperimentalTime
import kotlinx.datetime.DateTimeUnit
import kotlinx.datetime.TimeZone
import kotlinx.datetime.isoDayNumber
import kotlinx.datetime.plus
import kotlinx.datetime.todayIn

/**
 * What a stat card shows for a given stream state.
 *
 * Every count on this screen is derived with `(state as? Data)?.value?.size ?: 0`,
 * so an Error collapses to 0 before it ever reaches the card. Printing that 0
 * makes a broken read look identical to an empty one. Caught live on production
 * 2026-07-15: `bookingRequestsStream()` was permission-denied and "Open bookings"
 * rendered "0 / needs a reply" with nothing anywhere saying it had failed.
 *
 * [ready] is what to show once the data is really there (already the `?: 0` value,
 * which is exactly why it must not be trusted on Error).
 */
internal fun statCardValue(state: FirestoreResult<*>, ready: String): String = when (state) {
    is FirestoreResult.Loading -> "…"
    is FirestoreResult.Error -> "-"
    is FirestoreResult.Data -> ready
}

/** Trend line under a stat card: says what broke on Error, normal copy otherwise. */
internal fun statCardTrend(state: FirestoreResult<*>, ready: String, failed: String): String =
    if (state is FirestoreResult.Error) failed else ready

/**
 * Value for the count-up roll, or null to suppress it. Rolling to 0 on a failed
 * read would animate the lie rather than just print it.
 */
internal fun statCardNumeric(state: FirestoreResult<*>, ready: Double): Double? =
    if (state is FirestoreResult.Data) ready else null

/**
 * Den-redesign Home ("The Den · Home" dashboard).
 *
 * Mirrors ui-ideas/auntieos-redesign-2026-05-27.html: a date kicker + time-aware
 * greeting, a four-card stat row, and a two-column "Today's Pack" / "KinTales
 * pending" grid - all built from the shared DenScreenKit. Counts/lists are wired
 * to real Firestore streams; the mockup's "This week $" revenue stat has no
 * aggregation yet so it is gated behind [LocalFeatureFlags] (off → the 4th card
 * shows the real active-Kinfolk count instead).
 */
@Composable
fun HomeScreen(
    authUser: AuthUser? = null,
    onNavigate: (Destination) -> Unit,
) {
    val c = AuntieTheme.colors
    val client = remember { FirestoreClient() }

    // P0-FLICKER: hoist Flow construction via remember so the same Flow survives
    // recomposition (otherwise data flickers Loading -> Data each frame).
    val sessionsState by remember { client.sessionsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val draftsState   by remember { client.generatedDraftsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val kinfolkState  by remember { client.kinfolkStream() }.collectAsState(initial = FirestoreResult.Loading)
    val bookingsState by remember { client.bookingRequestsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val invoicesState by remember { client.invoicesStream() }.collectAsState(initial = FirestoreResult.Loading)
    // 17.2 Branding: operator-editable Home greeting + accent word (blank -> shipped default).
    val settingsState by remember { client.businessSettingsStream() }.collectAsState(initial = FirestoreResult.Loading)
    // 17.3 Dashboard: per-admin widget layout, persisted to users/{uid}.dashboardWidgets.
    val uid = authUser?.uid
    val profileState by remember(uid) {
        uid?.let { client.userProfileStream(it) } ?: flowOf(FirestoreResult.Data<UserProfile?>(null))
    }.collectAsState(initial = FirestoreResult.Loading)

    val sessions = (sessionsState as? FirestoreResult.Data)?.value.orEmpty()
    // Drop content-less junk docs (leftover all-null import/seed rows with no
    // generatedCopy): they are nothing to review and would render as "No recipient".
    val drafts   = (draftsState as? FirestoreResult.Data)?.value.orEmpty()
        .filter { it.generatedCopy.isNotBlank() }
    val todayKey = nowIso().take(10)
    val todaySessions = sessions.filter { it.startTime.take(10) == todayKey }
        .sortedBy { it.startTime }
    val doneCount = todaySessions.count { it.status.uppercase() == "COMPLETED" }
    val onWayCount = todaySessions.count { it.status.uppercase() in setOf("ON_MY_WAY", "ARRIVED") }

    val draftsPending = drafts.filter { it.status.lowercase() != "approved" }
    val kinfolkCount = (kinfolkState as? FirestoreResult.Data)?.value?.count { it.status != "archived" } ?: 0
    // Bookings stream is pre-filtered to booking requests server-side; count the
    // stream length (the old `status=='pending'` predicate was dead - stream is DRAFT).
    val openBookings = (bookingsState as? FirestoreResult.Data)?.value?.size ?: 0

    // "This week $" revenue: sum of PAID invoices dated within the current local
    // week (Monday..today). Real aggregation over the loaded invoices stream via
    // the pure weeklyRevenue() helper. Fail loud on a stream error below.
    val invoices = (invoicesState as? FirestoreResult.Data)?.value.orEmpty()
    val weekStartKey = remember { localWeekStartIso() }
    val weekRevenue = weeklyRevenue(invoices, weekStartKey, todayKey)
    // Cash Flow widget: invoices still owed (grouped by amountDue per the model).
    val outstandingInvoices = invoices.filter { it.amountDue > 0.0 }
    val outstandingTotal = outstandingInvoices.sumOf { it.amountDue }
    // Gatekeeper widget: households with the longest gap since their last visit.
    val visitGaps = householdVisitGaps(sessions, todayKey, limit = 5)

    // Resolve the heading: operator overrides (if set) else the time-aware default.
    val businessSettings = (settingsState as? FirestoreResult.Data)?.value ?: BusinessSettings()
    val heading = homeHeading(businessSettings, greetingForHour(denCurrentHour()))

    // 17.3 Dashboard customization. layout seeds from the saved tokens (empty -> the
    // default = today's exact layout, zero regression); edits persist to users/{uid}
    // via saveUserProfile, serialized behind a Mutex and copied onto the LIVE profile
    // so theme/branding/etc are never clobbered. Fail loud on a save error.
    val profile = (profileState as? FirestoreResult.Data)?.value
    val liveProfile by rememberUpdatedState(profile)
    val savedTokens = profile?.dashboardWidgets ?: emptyList()
    var editing by remember { mutableStateOf(false) }
    var layout by remember(savedTokens) { mutableStateOf(resolvedDashboard(savedTokens)) }
    var dashError by remember { mutableStateOf<String?>(null) }

    // W16/W17 weather: a one-shot callable (server-cached ~30min), loaded only when a
    // weather widget is actually on the dashboard. null = not loaded yet.
    val showsWeather = layout.any { it.key == DashKey.WEATHER_WATCHDOG || it.key == DashKey.HEAT_INDEX }
    var weather by remember { mutableStateOf<WriteResult<LocalWeather>?>(null) }
    LaunchedEffect(showsWeather) { if (showsWeather && weather == null) weather = client.getLocalWeather() }
    // W10 pets-by-type: the all-kin stream is only subscribed while the widget is
    // actually on the dashboard (same lazy pattern as the weather widgets).
    val showsPets = layout.any { it.key == DashKey.PET_BREAKDOWN }
    val allKinState by remember(showsPets) {
        if (showsPets) client.allKinStream() else flowOf<FirestoreResult<List<Kin>>>(FirestoreResult.Loading)
    }.collectAsState(initial = FirestoreResult.Loading)
    // AO-38 unread messages: one-shot listConversations (callable, not a stream),
    // loaded only while the widget is on the dashboard. null = not loaded yet.
    val showsUnread = layout.any { it.key == DashKey.UNREAD_MESSAGES }
    var conversations by remember { mutableStateOf<WriteResult<List<ConversationSummary>>?>(null) }
    LaunchedEffect(showsUnread) { if (showsUnread && conversations == null) conversations = client.listConversations() }
    val dashScope = rememberReportingScope()
    val dashSaveMutex = remember { Mutex() }
    val applyLayout: (List<DashWidget>) -> Unit = { next ->
        layout = next
        liveProfile?.let { base ->
            dashScope.launch {
                dashSaveMutex.withLock {
                    when (val r = client.saveUserProfile(base.copy(dashboardWidgets = next.toTokens()))) {
                        is WriteResult.Err -> dashError = "Couldn't save dashboard: ${r.message}"
                        is WriteResult.Ok -> dashError = null
                    }
                }
            }
        }
    }

    ScreenScaffold {
        DenScreenHeading(
            kicker     = "Today · ${todaySessions.size} visit${if (todaySessions.size == 1) "" else "s"} on the books",
            title      = heading.title,
            accentTail = heading.accentTail,
            trailing = {
                if (profile != null) {
                    GhostButton(
                        label = if (editing) "Done" else "Customize",
                        onClick = { editing = !editing; if (!editing) dashError = null },
                    )
                }
            },
        )
        Spacer(Modifier.height(20.dp))

        // Fail loud: disclose when the branding/settings stream errored - the heading
        // and nav-rail brand fall back to shipped defaults, which must not be passed
        // off as the operator's own customization (17.2).
        (settingsState as? FirestoreResult.Error)?.let { err ->
            AuntieBanner(
                tone  = AuntieBannerTone.Error,
                title = "Couldn't load branding; showing defaults",
            ) {
                Text(err.message, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
            Spacer(Modifier.height(16.dp))
        }

        // Fail loud: a broken invoices stream must not silently render $0.00 revenue.
        (invoicesState as? FirestoreResult.Error)?.let { err ->
            AuntieBanner(
                tone  = AuntieBannerTone.Error,
                title = "Couldn't load this week's revenue",
            ) {
                Text(err.message, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
            Spacer(Modifier.height(16.dp))
        }

        // Fail loud: a dashboard layout save failure must not pass as saved.
        dashError?.let { msg ->
            AuntieBanner(tone = AuntieBannerTone.Error, title = "Couldn't save dashboard") {
                Text(msg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
            Spacer(Modifier.height(16.dp))
        }

        // 17.3: render the dashboard widgets per the resolved layout. A WIDE widget is a
        // full-width row; consecutive COMPACT widgets pair two-to-a-row.
        packRows(layout).forEach { row ->
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                row.forEach { w ->
                    val idx = layout.indexOf(w)
                    Column(modifier = Modifier.weight(1f)) {
                        if (editing) {
                            WidgetEditBar(
                                label = dashLabel(w.key),
                                canMoveUp = idx > 0,
                                canMoveDown = idx >= 0 && idx < layout.lastIndex,
                                isWide = w.size == DashSize.WIDE,
                                resizable = w.key != DashKey.STATS,
                                onUp = { applyLayout(moveWidgetUp(layout, idx)) },
                                onDown = { applyLayout(moveWidgetDown(layout, idx)) },
                                onToggleSize = {
                                    applyLayout(setWidgetSize(layout, w.key, if (w.size == DashSize.WIDE) DashSize.COMPACT else DashSize.WIDE))
                                },
                                onHide = { applyLayout(hideWidget(layout, w.key)) },
                            )
                            Spacer(Modifier.height(8.dp))
                        }
                        DashRevealItem(index = if (idx >= 0) idx else 0) {
                        when (w.key) {
                            DashKey.STATS -> Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(12.dp),
                            ) {
                                StatCard(
                                    label = "Today's pack",
                                    value = statCardValue(sessionsState, todaySessions.size.toString()),
                                    numericValue = statCardNumeric(sessionsState, todaySessions.size.toDouble()),
                                    formatValue = { it.roundToInt().toString() },
                                    trend = statCardTrend(
                                        sessionsState,
                                        ready = "$doneCount done, $onWayCount on the way",
                                        failed = "Couldn't load visits",
                                    ),
                                    tone = AuntieStatusTone.Orange,
                                    feature = true,
                                    modifier = Modifier.weight(1.5f),
                                    onClick = { onNavigate(Destination.Sessions) },
                                )
                                StatCard(
                                    label = "KinTales to review",
                                    value = statCardValue(draftsState, draftsPending.size.toString()),
                                    numericValue = statCardNumeric(draftsState, draftsPending.size.toDouble()),
                                    formatValue = { it.roundToInt().toString() },
                                    trend = statCardTrend(
                                        draftsState,
                                        ready = "${drafts.size} total drafts",
                                        failed = "Couldn't load drafts",
                                    ),
                                    tone = AuntieStatusTone.Teal,
                                    modifier = Modifier.weight(1f),
                                    onClick = { onNavigate(Destination.Communicate) },
                                )
                                // Home has no bookings PANEL, so this card is the only place a
                                // bookingRequestsStream failure can ever surface. Before this, a
                                // permission-denied rendered as "0 / needs a reply" and the
                                // operator had no way to know requests were waiting.
                                StatCard(
                                    label = "Open bookings",
                                    value = statCardValue(bookingsState, openBookings.toString()),
                                    numericValue = statCardNumeric(bookingsState, openBookings.toDouble()),
                                    formatValue = { it.roundToInt().toString() },
                                    trend = statCardTrend(
                                        bookingsState,
                                        ready = "needs a reply",
                                        failed = "Couldn't load bookings",
                                    ),
                                    tone = AuntieStatusTone.Purple,
                                    modifier = Modifier.weight(1f),
                                    onClick = { onNavigate(Destination.Bookings) },
                                )
                                StatCard(
                                    label = "This week",
                                    value = when {
                                        invoicesState is FirestoreResult.Loading -> "…"
                                        invoicesState is FirestoreResult.Error    -> "-"
                                        else                                       -> formatMoney(weekRevenue)
                                    },
                                    numericValue = statCardNumeric(invoicesState, weekRevenue),
                                    formatValue = { formatMoney(it) },
                                    // "see error above" pointed at nothing: Home renders no
                                    // invoices panel, so this card must say it itself.
                                    trend = statCardTrend(
                                        invoicesState,
                                        ready = "revenue from paid invoices",
                                        failed = "Couldn't load invoices",
                                    ),
                                    tone = AuntieStatusTone.Success,
                                    modifier = Modifier.weight(1f),
                                    onClick = { onNavigate(Destination.Invoices) },
                                )
                            }
                            DashKey.TODAYS_PACK -> DenPanel(
                                title = "Today's Pack",
                                subtitle = "Your visit run for the day. Tap a card to open the booking.",
                                modifier = Modifier.fillMaxWidth(),
                                hoverLift = true,
                            ) {
                                when {
                                    sessionsState is FirestoreResult.Loading ->
                                        EmptyHint("Loading today's visits…")
                                    sessionsState is FirestoreResult.Error ->
                                        EmptyHint("Couldn't load visits: ${(sessionsState as FirestoreResult.Error).message}", error = true)
                                    todaySessions.isEmpty() ->
                                        EmptyHint("Nothing on the books today. Enjoy the quiet.")
                                    else -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                        todaySessions.take(6).forEach { VisitRow(it) { onNavigate(Destination.Sessions) } }
                                    }
                                }
                                Spacer(Modifier.height(12.dp))
                                GhostButton(label = "Open full schedule →", onClick = { onNavigate(Destination.Schedule) })
                            }
                            DashKey.KINTALES -> DenPanel(
                                title = "KinTales pending",
                                subtitle = "Visit reports waiting for your sign-off.",
                                modifier = Modifier.fillMaxWidth(),
                                hoverLift = true,
                            ) {
                                when {
                                    draftsState is FirestoreResult.Loading -> EmptyHint("Loading drafts…")
                                    draftsState is FirestoreResult.Error ->
                                        EmptyHint("Couldn't load drafts: ${(draftsState as FirestoreResult.Error).message}", error = true)
                                    draftsPending.isEmpty() -> EmptyHint("All caught up, no drafts waiting.")
                                    else -> Column(verticalArrangement = Arrangement.spacedBy(11.dp)) {
                                        draftsPending.take(4).forEachIndexed { i, d -> TaleRow(d, i) }
                                    }
                                }
                                Spacer(Modifier.height(14.dp))
                                PrimaryButton(
                                    label = "Review & send tales",
                                    onClick = { onNavigate(Destination.Communicate) },
                                    modifier = Modifier.fillMaxWidth(),
                                    leading = { Icon(Lucide.Pencil, contentDescription = null, modifier = Modifier.size(14.dp)) },
                                )
                            }
                            DashKey.CASH_FLOW -> DenPanel(
                                title = "Cash Flow",
                                subtitle = "Money in this week, and what's still owed.",
                                modifier = Modifier.fillMaxWidth(),
                                hoverLift = true,
                            ) {
                                when {
                                    invoicesState is FirestoreResult.Loading -> EmptyHint("Loading invoices…")
                                    invoicesState is FirestoreResult.Error ->
                                        EmptyHint("Couldn't load invoices: ${(invoicesState as FirestoreResult.Error).message}", error = true)
                                    else -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                        CashFlowRow("Earned this week", formatMoney(weekRevenue), AuntieStatusTone.Success)
                                        CashFlowRow(
                                            "Outstanding", formatMoney(outstandingTotal),
                                            if (outstandingTotal > 0.0) AuntieStatusTone.Orange else AuntieStatusTone.Success,
                                        )
                                        Text(
                                            "${outstandingInvoices.size} unpaid invoice${if (outstandingInvoices.size == 1) "" else "s"}",
                                            style = AuntieTheme.typography.bodySmall,
                                            color = AuntieTheme.colors.textDim,
                                        )
                                    }
                                }
                                Spacer(Modifier.height(12.dp))
                                GhostButton(label = "Open invoices →", onClick = { onNavigate(Destination.Invoices) })
                            }
                            DashKey.GATEKEEPER -> DenPanel(
                                title = "Gatekeeper",
                                subtitle = "Households going longest without a visit — close the gaps.",
                                modifier = Modifier.fillMaxWidth(),
                                hoverLift = true,
                            ) {
                                when {
                                    sessionsState is FirestoreResult.Loading -> EmptyHint("Loading visits…")
                                    sessionsState is FirestoreResult.Error ->
                                        EmptyHint("Couldn't load visits: ${(sessionsState as FirestoreResult.Error).message}", error = true)
                                    visitGaps.isEmpty() -> EmptyHint("No completed visits yet to measure gaps.")
                                    else -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                        visitGaps.forEach { gap ->
                                            val gapColor = when {
                                                gap.daysSinceLastVisit >= 14 -> AuntieTheme.colors.error
                                                gap.daysSinceLastVisit >= 7 -> AuntieStatusTone.Orange.color(AuntieTheme.colors)
                                                else -> AuntieStatusTone.Success.color(AuntieTheme.colors)
                                            }
                                            Row(
                                                modifier = Modifier.fillMaxWidth(),
                                                horizontalArrangement = Arrangement.SpaceBetween,
                                                verticalAlignment = Alignment.CenterVertically,
                                            ) {
                                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                                    if (gap.daysSinceLastVisit >= 14) {
                                                        PulsingBadge(color = gapColor, size = 8.dp)
                                                    }
                                                    Text(gap.household, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary)
                                                }
                                                Text("${gap.daysSinceLastVisit}d", style = AuntieTheme.typography.titleMedium, color = gapColor)
                                            }
                                        }
                                    }
                                }
                            }
                            DashKey.WEATHER_WATCHDOG -> DenPanel(
                                title = "Weather Watchdog",
                                subtitle = "Pavement heat + active weather alerts before you walk.",
                                modifier = Modifier.fillMaxWidth(),
                                hoverLift = true,
                            ) {
                                WeatherWidgetBody(weather) { w ->
                                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                        WeatherHeadRow(w)
                                        WeatherRiskRow("Pavement / paw risk", pawBurnRisk(w.tempF))
                                        if (w.alerts.isEmpty()) {
                                            Text("No active NWS alerts.", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
                                        } else {
                                            w.alerts.take(2).forEach { a ->
                                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                                    PulsingBadge(color = AuntieTheme.colors.error, size = 8.dp)
                                                    Text("⚠ ${a.event}", style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.error)
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            DashKey.HEAT_INDEX -> DenPanel(
                                title = "Heat Stroke Index",
                                subtitle = "Temperature + humidity, read as a canine heat-risk level.",
                                modifier = Modifier.fillMaxWidth(),
                                hoverLift = true,
                            ) {
                                WeatherWidgetBody(weather) { w ->
                                    val hi = heatIndexF(w.tempF, w.humidityPct)
                                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                        WeatherHeadRow(w)
                                        CashFlowRow("Feels like", hi?.let { "$it°F" } ?: "—", AuntieStatusTone.Teal)
                                        WeatherRiskRow("Canine heat risk", canineHeatRisk(hi))
                                    }
                                }
                            }
                            DashKey.WEEKLY_CAPACITY -> WeeklyCapacityWidget(sessionsState, todayKey)
                            DashKey.OVERDUE_TRACKER -> OverdueVisitsWidget(sessionsState, nowIso())
                            DashKey.PET_BREAKDOWN -> PetBreakdownWidget(allKinState)
                            DashKey.FREQUENT_FLYERS -> FrequentFlyersWidget(sessionsState, todayKey)
                            DashKey.HOLIDAY_RUNWAY -> HolidayRunwayWidget(sessionsState, todayKey)
                            DashKey.UNREAD_MESSAGES -> UnreadMessagesWidget(conversations)
                            DashKey.SAFEBOX -> SafeboxWidget(sessionsState, kinfolkState, nowIso())
                        }
                        }
                    }
                }
            }
            Spacer(Modifier.height(20.dp))
        }

        // 17.3: in edit mode, offer any hidden cards for re-adding.
        if (editing) {
            val hidden = hiddenKeys(layout)
            if (hidden.isNotEmpty()) {
                DenPanel(title = "Hidden cards", subtitle = "Add a card back to your dashboard.") {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        hidden.forEach { k ->
                            GhostButton(label = dashLabel(k), onClick = { applyLayout(showWidget(layout, k)) })
                        }
                    }
                }
            }
        }
    }
}

/** Human label for a dashboard widget key (edit chrome + hidden strip). */
private fun dashLabel(key: DashKey): String = when (key) {
    DashKey.STATS -> "Stats"
    DashKey.TODAYS_PACK -> "Today's Pack"
    DashKey.KINTALES -> "KinTales"
    DashKey.CASH_FLOW -> "Cash Flow"
    DashKey.GATEKEEPER -> "Gatekeeper"
    DashKey.WEATHER_WATCHDOG -> "Weather Watchdog"
    DashKey.HEAT_INDEX -> "Heat Stroke Index"
    DashKey.WEEKLY_CAPACITY -> "Weekly capacity"
    DashKey.OVERDUE_TRACKER -> "Overdue visits"
    DashKey.PET_BREAKDOWN -> "Pets by type"
    DashKey.FREQUENT_FLYERS -> "Frequent flyers"
    DashKey.HOLIDAY_RUNWAY -> "Holiday runway"
    DashKey.UNREAD_MESSAGES -> "Unread messages"
    DashKey.SAFEBOX -> "Key & code safebox"
}

/** Den tone for a [WeatherRisk] level. */
private fun weatherRiskTone(risk: WeatherRisk): AuntieStatusTone = when (risk) {
    WeatherRisk.Ok -> AuntieStatusTone.Success
    WeatherRisk.Caution -> AuntieStatusTone.Orange
    WeatherRisk.High -> AuntieStatusTone.Orange
    WeatherRisk.Danger -> AuntieStatusTone.Purple
}

private fun weatherRiskLabel(risk: WeatherRisk): String = when (risk) {
    WeatherRisk.Ok -> "OK"
    WeatherRisk.Caution -> "Caution"
    WeatherRisk.High -> "High"
    WeatherRisk.Danger -> "Danger"
}

/** Handles the weather widget's load / error (fail-loud) / ready states. */
@Composable
private fun WeatherWidgetBody(state: WriteResult<LocalWeather>?, content: @Composable (LocalWeather) -> Unit) {
    when (state) {
        null -> EmptyHint("Loading weather…")
        is WriteResult.Err -> {
            val msg = if (state.message.contains("weather_location_not_set")) {
                "Set your weather area (city, metro, or ZIP) in Settings to enable weather."
            } else {
                "Couldn't load weather: ${state.message}"
            }
            EmptyHint(msg, error = true)
        }
        is WriteResult.Ok -> content(state.value)
    }
}

/** City + current temp + short forecast line shared by both weather widgets. */
@Composable
private fun WeatherHeadRow(w: LocalWeather) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column {
            Text(
                listOf(w.city, w.state).filter { it.isNotBlank() }.joinToString(", ").ifBlank { "Local" },
                style = AuntieTheme.typography.bodyMedium,
                color = AuntieTheme.colors.textPrimary,
            )
            if (w.shortForecast.isNotBlank()) {
                Text(w.shortForecast, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
            }
        }
        Text(
            w.tempF?.let { "$it°F" } ?: "—°",
            style = AuntieTheme.typography.headlineSmall,
            color = AuntieTheme.colors.textPrimary,
        )
    }
}

/** A labelled, tone-coloured risk pill row. */
@Composable
private fun WeatherRiskRow(label: String, risk: WeatherRisk) {
    val tone = weatherRiskTone(risk)
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textDim)
        Box(
            modifier = Modifier
                .clip(RoundedCornerShape(999.dp))
                .background(tone.color(AuntieTheme.colors).copy(alpha = 0.16f))
                .padding(horizontal = 12.dp, vertical = 4.dp),
        ) {
            Text(weatherRiskLabel(risk), style = AuntieTheme.typography.labelMedium, color = tone.color(AuntieTheme.colors))
        }
    }
}

/** One labelled money row for the Cash Flow widget. */
@Composable
private fun CashFlowRow(label: String, value: String, tone: AuntieStatusTone) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textDim)
        Text(value, style = AuntieTheme.typography.titleMedium, color = tone.color(AuntieTheme.colors))
    }
}

data class HouseholdGap(val household: String, val daysSinceLastVisit: Int)

/**
 * Gatekeeper widget logic: per-household days since the last COMPLETED visit,
 * longest gap first. Parses the visit date off completedAt (else startTime); a
 * household with no parseable completed visit, or a future date, is dropped.
 */
internal fun householdVisitGaps(
    sessions: List<KinCareSession>,
    todayIso: String,
    limit: Int = 5,
): List<HouseholdGap> {
    val today = runCatching { kotlinx.datetime.LocalDate.parse(todayIso) }.getOrNull() ?: return emptyList()
    return sessions
        .filter { it.status.uppercase() == "COMPLETED" }
        .groupBy { it.kinfolkId.ifBlank { it.kinfolkName } }
        .mapNotNull { (_, group) ->
            val name = group.firstOrNull { it.kinfolkName.isNotBlank() }?.kinfolkName ?: return@mapNotNull null
            val lastDate = group
                .mapNotNull { s ->
                    runCatching { kotlinx.datetime.LocalDate.parse((s.completedAt.ifBlank { s.startTime }).take(10)) }.getOrNull()
                }
                .maxOrNull() ?: return@mapNotNull null
            val days = (today.toEpochDays() - lastDate.toEpochDays()).toInt()
            if (days < 0) null else HouseholdGap(name, days)
        }
        .sortedByDescending { it.daysSinceLastVisit }
        .take(limit)
}

/** 17.3 edit-mode header on each dashboard widget: reorder / resize / hide. */
@Composable
private fun WidgetEditBar(
    label: String,
    canMoveUp: Boolean,
    canMoveDown: Boolean,
    isWide: Boolean,
    resizable: Boolean,
    onUp: () -> Unit,
    onDown: () -> Unit,
    onToggleSize: () -> Unit,
    onHide: () -> Unit,
) {
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(c.surface)
            .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(12.dp))
            .padding(horizontal = 10.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(label, style = AuntieTheme.typography.labelLarge, color = c.textPrimary, modifier = Modifier.weight(1f))
        AuntieIconButton(icon = Lucide.ArrowUp, contentDescription = "Move $label up", onClick = onUp, size = 30.dp, enabled = canMoveUp)
        AuntieIconButton(icon = Lucide.ArrowDown, contentDescription = "Move $label down", onClick = onDown, size = 30.dp, enabled = canMoveDown)
        if (resizable) {
            GhostButton(label = if (isWide) "Wide" else "Compact", onClick = onToggleSize)
        }
        AuntieIconButton(icon = Lucide.EyeOff, contentDescription = "Hide $label", onClick = onHide, size = 30.dp, destructive = true)
    }
}

/** A single visit row in Today's Pack: tinted paw avatar, name + service,
 *  service pill, time + status. */
@Composable
private fun VisitRow(session: KinCareSession, onClick: () -> Unit) {
    val c = AuntieTheme.colors
    val tone = serviceTone(session.serviceType)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(13.dp))
            .clickable(onClick = onClick)
            .padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(13.dp),
    ) {
        AuntieIconTile(icon = Lucide.PawPrint, tone = tone, size = 38.dp)
        Column(Modifier.weight(1f)) {
            Text(
                session.kinfolkName.ifBlank { "Kinfolk" },
                style = AuntieTheme.typography.titleSmall, color = c.textPrimary,
            )
            Text(
                session.serviceType.ifBlank { "Visit" },
                style = AuntieTheme.typography.bodySmall, color = c.textDim,
            )
        }
        ServicePill(session.serviceType, tone)
        Spacer(Modifier.width(4.dp))
        Column(horizontalAlignment = Alignment.End) {
            Text(formatTime(session.startTime), style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
            Text(statusLabel(session.status), style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
    }
}

/**
 * YYYY-MM-DD of the Monday that begins the current local week. Used as the lower
 * bound for the "This week $" revenue window (weeklyRevenue takes Monday..today).
 */
@OptIn(ExperimentalTime::class)
private fun localWeekStartIso(): String {
    val zone = TimeZone.currentSystemDefault()
    val today = Clock.System.todayIn(zone)
    val monday = today.plus(-(today.dayOfWeek.isoDayNumber - 1), DateTimeUnit.DAY)
    return monday.toString()
}

/** A KinTales-pending tale row: colored mark, title, blurb, mono meta line. */
@Composable
private fun TaleRow(draft: GeneratedDraft, index: Int) {
    val c = AuntieTheme.colors
    val markTone = when (index % 3) { 0 -> c.primary; 1 -> c.secondary; else -> c.accent }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(13.dp))
            .background(c.surfaceGlass)
            .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(13.dp))
            .padding(13.dp),
        horizontalArrangement = Arrangement.spacedBy(11.dp),
    ) {
        Box(Modifier.width(4.dp).height(40.dp).clip(RoundedCornerShape(4.dp)).background(markTone))
        Column(Modifier.weight(1f)) {
            Text(
                draft.communicationType.replace("_", " ").ifBlank { "Visit report" },
                style = AuntieTheme.typography.titleSmall, color = c.textPrimary,
            )
            // item 6: blurb = first line of the real draft copy (was a redundant
            // second copy of kinfolkName, which then repeated in the meta line).
            Text(
                draft.generatedCopy.lineSequence().firstOrNull { it.isNotBlank() }?.trim()?.take(80)
                    ?.ifBlank { null } ?: "No copy yet",
                style = AuntieTheme.typography.bodySmall, color = c.textDim,
                maxLines = 1,
            )
            Spacer(Modifier.height(5.dp))
            // item 6: meta = STATUS · household (name appears ONCE now). createdOn
            // appended only when present (no fabricated relative time).
            Text(
                buildString {
                    append(draft.status.uppercase())
                    if (draft.kinfolkName.isNotBlank()) append(" · ${draft.kinfolkName}")
                    if (draft.createdOn.isNotBlank()) append(" · ${draft.createdOn.take(10)}")
                },
                style = AuntieTheme.typography.mono.copy(fontSize = 10.5.sp, letterSpacing = 0.4.sp),
                color = c.textFaint,
            )
        }
    }
}
