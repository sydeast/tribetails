package com.tribetails.auntieos.ui.home

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.ui.draw.alpha
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tribetails.auntieos.data.model.Draft
import com.tribetails.auntieos.data.model.VisitStatus
import com.tribetails.auntieos.ui.branding.brandIdentity
import com.tribetails.auntieos.ui.branding.homeHeading
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.components.AuntiePullRefresh
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AnimatedMeshBackground
import com.tribetails.auntieos.ui.components.AuntieIconTile
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.components.ServicePill
import com.tribetails.auntieos.ui.components.StatCard
import com.tribetails.auntieos.ui.components.SlideInCard
import com.tribetails.auntieos.ui.components.denCurrentHour
import com.tribetails.auntieos.ui.components.formatTime
import com.tribetails.auntieos.ui.components.greetingForHour
import com.tribetails.auntieos.ui.components.serviceTone
import com.tribetails.auntieos.ui.components.statusLabel
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlin.math.roundToInt

/**
 * Den-redesign Home dashboard (Android), ported from the web counterpart at
 * web/.../screens/home/HomeScreen.kt: a date kicker + time-aware serif greeting
 * (DenScreenHeading), a stat row, then a "Today's Pack" + "KinTales pending"
 * pair built from the shared Den component kit.
 *
 * Phone-width layout differs from web: the four stat cards wrap into a 2x2 grid
 * and the two panels stack vertically instead of sitting side by side.
 *
 * VM-state mapping (HomeUiState): Today's pack = todayVisits.size; KinTales to
 * review = pendingDraftCount; "Kin in care" = kinCount (no open-bookings stream
 * exists in the Android VM, so the web's "Open bookings" card is replaced with
 * an honest kin count rather than inventing a stream); Kinfolk = kinfolkCount.
 *
 * All visit lifecycle wiring, GPS, and notifier calls are preserved verbatim;
 * only the surrounding surface is restyled to the Den layout.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun HomeScreen(
    viewModel: HomeViewModel,
    onNavigateToCommunicate: () -> Unit,
    onNavigateToCalls: () -> Unit,
    onWriteKinTale: (sessionId: String) -> Unit,
    onLiveTrack: (sessionId: String, kinfolkId: String, kinfolkName: String) -> Unit = { _, _, _ -> },
    onViewRoute: (routeId: String, kinfolkName: String) -> Unit = { _, _ -> },
) {
    val state by viewModel.uiState.collectAsState()
    val context = LocalContext.current

    // 17.2 Branding: resolve the operator's Home heading + brand identity off the
    // loaded settings (blank fields fall back to the shipped defaults).
    val heading = homeHeading(state.businessSettings, greetingForHour(denCurrentHour()))
    val brand = brandIdentity(state.businessSettings)

    // 17.3 Dashboard: resolved widget layout (empty -> default = today's exact set).
    // On a phone the cards stack full-width in order; reorder + hide are the mobile
    // customizations (size is a wide-screen/web concern, preserved on round-trip).
    val dashboard = resolvedDashboard(state.dashboardWidgets)
    var editing by remember { mutableStateOf(false) }

    // W16/W17: fetch weather only when a weather widget is on the dashboard.
    val showsWeather = dashboard.any { it.key == DashKey.WEATHER_WATCHDOG || it.key == DashKey.HEAT_INDEX }
    LaunchedEffect(showsWeather) { if (showsWeather) viewModel.loadWeather() }

    AuntieScreenScaffold(
        title = null,
        backgroundFullBleed = true,
    ) {
    Box(modifier = Modifier.fillMaxSize()) {
        AnimatedMeshBackground()
        AuntiePullRefresh(
            isRefreshing = state.isLoading,
            onRefresh = { viewModel.load() },
        ) {
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
            contentPadding = PaddingValues(vertical = 24.dp)
        ) {

        // ── 17.2 brand block: shows once the operator sets a logo. Android has no
        // persistent nav rail (the web rail carries the brand there), so the logo
        // gets its home here, above the greeting. AuntieAvatar falls back to the
        // PawPrint glyph on a broken URL (fail-visible, never an empty hole).
        if (brand.logoUrl.isNotBlank()) {
            item {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    AuntieAvatar(
                        imageUrl = brand.logoUrl,
                        glyph = Lucide.PawPrint,
                        size = 40.dp,
                        shape = RoundedCornerShape(14.dp),
                        gradientSeed = brand.wordmark,
                    )
                    Column {
                        Text(
                            brand.wordmark,
                            style = AuntieTheme.typography.headlineSmall,
                            color = AuntieTheme.colors.textPrimary,
                        )
                        Text(
                            brand.tagline,
                            style = AuntieTheme.typography.bodySmall,
                            color = AuntieTheme.colors.textDim,
                        )
                    }
                }
            }
        }

        // ── heading: date kicker + time-aware serif greeting ──────────────
        item {
            DenScreenHeading(
                kicker = "Today · ${state.todayVisits.size} visit${if (state.todayVisits.size == 1) "" else "s"} on the books",
                title = heading.title,
                accentTail = heading.accentTail,
                trailing = {
                    if (!state.isLoading) {
                        GhostButton(
                            label = if (editing) "Done" else "Customize",
                            onClick = { editing = !editing },
                        )
                    }
                },
            )
        }

        // Offline banner
        if (state.isOffline) {
            item {
                OfflineBanner(onRetry = viewModel::load)
            }
        }

        if (!state.actionError.isNullOrBlank()) {
            item {
                OfflineBanner(
                    message = state.actionError.orEmpty(),
                    onRetry = {
                        viewModel.clearActionError()
                        viewModel.load()
                    }
                )
            }
        }

        if (!state.isOffline) {
            // 17.3 Dashboard: render the widgets in the operator's saved order; hidden
            // widgets are omitted. On a phone everything stacks full-width. In edit mode
            // each widget gets a reorder/hide bar; hidden widgets are offered below.
            dashboard.forEach { w ->
                val idx = dashboard.indexOf(w)
                item(key = "dash_${w.key.name}") {
                    Column {
                        if (editing) {
                            WidgetEditBar(
                                label = dashLabel(w.key),
                                canMoveUp = idx > 0,
                                canMoveDown = idx in 0 until dashboard.lastIndex,
                                onUp = { viewModel.saveDashboard(moveWidgetUp(dashboard, idx).toTokens()) },
                                onDown = { viewModel.saveDashboard(moveWidgetDown(dashboard, idx).toTokens()) },
                                onHide = { viewModel.saveDashboard(hideWidget(dashboard, w.key).toTokens()) },
                            )
                            Spacer(Modifier.height(8.dp))
                        }
                        // 17.3 alive-widgets: staggered entrance (rise + fade) per
                        // the widget's seat in the layout, mirror of web DashRevealItem.
                        DashRevealItem(index = idx) {
                        when (w.key) {
                            DashKey.STATS -> {
                                val loadingValue = if (state.isLoading) "…" else null
                                val doneCount = state.todayVisits.count { it.session.status.uppercase() == "COMPLETED" }
                                val onWayCount = state.todayVisits.count {
                                    it.session.status.uppercase() in setOf("ON_MY_WAY", "ARRIVED")
                                }
                                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                                        StatCard(
                                            label = "Today's pack",
                                            value = loadingValue ?: state.todayVisits.size.toString(),
                                            numericValue = if (state.isLoading) null else state.todayVisits.size.toDouble(),
                                            formatValue = { it.roundToInt().toString() },
                                            trend = "$doneCount done, $onWayCount on the way",
                                            tone = AuntieStatusTone.Orange,
                                            feature = true,
                                            modifier = Modifier.weight(1.5f),
                                        )
                                        StatCard(
                                            label = "KinTales to review",
                                            value = loadingValue ?: state.pendingDraftCount.toString(),
                                            numericValue = if (state.isLoading) null else state.pendingDraftCount.toDouble(),
                                            formatValue = { it.roundToInt().toString() },
                                            trend = "${state.recentDrafts.size} recent drafts",
                                            tone = AuntieStatusTone.Teal,
                                            modifier = Modifier.weight(1f),
                                            onClick = onNavigateToCommunicate,
                                        )
                                    }
                                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.fillMaxWidth()) {
                                        StatCard(
                                            label = "Kin in care",
                                            value = loadingValue ?: state.kinCount.toString(),
                                            numericValue = if (state.isLoading) null else state.kinCount.toDouble(),
                                            formatValue = { it.roundToInt().toString() },
                                            trend = "across all households",
                                            tone = AuntieStatusTone.Purple,
                                            modifier = Modifier.weight(1f),
                                        )
                                        StatCard(
                                            label = "This week",
                                            value = loadingValue ?: formatRevenue(state.weeklyRevenue),
                                            numericValue = if (state.isLoading) null else state.weeklyRevenue,
                                            formatValue = { formatRevenue(it) },
                                            trend = "paid invoices this week",
                                            tone = AuntieStatusTone.Success,
                                            modifier = Modifier.weight(1f),
                                        )
                                    }
                                }
                            }
                            DashKey.TODAYS_PACK -> DenPanel(
                                title = "Today's Pack",
                                subtitle = "Your visit run for the day.",
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                when {
                                    state.isLoading -> EmptyHint("Loading today's visits…")
                                    state.todayVisits.isEmpty() ->
                                        EmptyHint("Nothing on the books today. Enjoy the quiet.")
                                    else -> Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                                        state.todayVisits.forEach { card ->
                                            SlideInCard(visible = true) {
                                                TodayVisitCardView(
                                                    card = card,
                                                    defaultEtaMinutes = state.businessSettings.defaultEtaMinutes,
                                                    etaOptions = state.businessSettings.etaMinuteOptions,
                                                    actionPending = state.pendingActionSessionId == card.session.id,
                                                    onMyWay = { eta -> viewModel.onMyWay(card.session.id, eta) },
                                                    onArrived = { viewModel.arrived(card.session.id, context) },
                                                    onDeparted = { viewModel.departed(card.session.id, context) },
                                                    onWriteKinTale = { onWriteKinTale(card.session.id) },
                                                    onComplete = { viewModel.complete(card.session.id) },
                                                    onLiveTrack = {
                                                        val s = card.session
                                                        onLiveTrack(s.id, s.kinfolkId, s.kinfolkName)
                                                    },
                                                    onViewRoute = {
                                                        val s = card.session
                                                        onViewRoute(s.visitRouteId, s.kinfolkName)
                                                    },
                                                )
                                            }
                                        }
                                    }
                                }
                                Spacer(Modifier.height(12.dp))
                                GhostButton(
                                    label = "View Calls",
                                    onClick = onNavigateToCalls,
                                    modifier = Modifier.fillMaxWidth(),
                                    leading = { Icon(Lucide.Phone, contentDescription = null, modifier = Modifier.size(16.dp)) },
                                )
                            }
                            DashKey.KINTALES -> DenPanel(
                                title = "KinTales pending",
                                subtitle = "Visit reports waiting for your sign-off.",
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                when {
                                    state.isLoading -> EmptyHint("Loading drafts…")
                                    state.recentDrafts.isEmpty() -> EmptyHint("All caught up, no drafts waiting.")
                                    else -> Column(verticalArrangement = Arrangement.spacedBy(11.dp)) {
                                        state.recentDrafts.take(4).forEachIndexed { i, d -> TaleRow(d, i) }
                                    }
                                }
                                Spacer(Modifier.height(14.dp))
                                PrimaryButton(
                                    label = "Review & send tales",
                                    onClick = onNavigateToCommunicate,
                                    modifier = Modifier.fillMaxWidth(),
                                    leading = { Icon(Lucide.Pencil, contentDescription = null, modifier = Modifier.size(16.dp)) },
                                )
                            }
                            DashKey.CASH_FLOW -> DenPanel(
                                title = "Cash Flow",
                                subtitle = "Money in this week, and what's still owed.",
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                when {
                                    state.isLoading -> EmptyHint("Loading invoices…")
                                    !state.invoicesLoaded -> EmptyHint("Couldn't load invoices. Pull to refresh.")
                                    else -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                        CashFlowRow("Earned this week", formatMoney(state.weeklyRevenue), AuntieStatusTone.Success)
                                        CashFlowRow(
                                            "Outstanding", formatMoney(state.outstandingTotal),
                                            if (state.outstandingTotal > 0.0) AuntieStatusTone.Orange else AuntieStatusTone.Success,
                                        )
                                        Text(
                                            "${state.outstandingCount} unpaid invoice${if (state.outstandingCount == 1) "" else "s"}",
                                            style = AuntieTheme.typography.bodySmall,
                                            color = AuntieTheme.colors.textDim,
                                        )
                                    }
                                }
                            }
                            DashKey.GATEKEEPER -> DenPanel(
                                title = "Gatekeeper",
                                subtitle = "Households going longest without a visit. Close the gaps.",
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                when {
                                    state.isLoading -> EmptyHint("Loading visits…")
                                    !state.gapsLoaded -> EmptyHint("Couldn't load visits. Pull to refresh.")
                                    state.visitGaps.isEmpty() -> EmptyHint("No completed visits yet to measure gaps.")
                                    else -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                        state.visitGaps.forEach { gap -> GatekeeperRow(gap) }
                                    }
                                }
                            }
                            DashKey.WEATHER_WATCHDOG -> DenPanel(
                                title = "Weather Watchdog",
                                subtitle = "Pavement heat + active weather alerts before you walk.",
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                WeatherWidgetBody(state.weather) { w ->
                                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                        WeatherHeadRow(w)
                                        WeatherRiskRow("Pavement / paw risk", pawBurnRisk(w.tempF))
                                        if (w.alerts.isEmpty()) {
                                            Text("No active NWS alerts.", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
                                        } else {
                                            w.alerts.take(2).forEach { a ->
                                                Text("⚠ ${a.event}", style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.error)
                                            }
                                        }
                                    }
                                }
                            }
                            DashKey.HEAT_INDEX -> DenPanel(
                                title = "Heat Stroke Index",
                                subtitle = "Temperature + humidity, read as a canine heat-risk level.",
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                WeatherWidgetBody(state.weather) { w ->
                                    val hi = heatIndexF(w.tempF, w.humidityPct)
                                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                        WeatherHeadRow(w)
                                        WeatherKeyValueRow("Feels like", hi?.let { "$it°F" } ?: "—")
                                        WeatherRiskRow("Canine heat risk", canineHeatRisk(hi))
                                    }
                                }
                            }
                            // AO-24: A8 insight widgets (android parity). Hidden by default;
                            // the operator adds them from Customize. Data lives on the VM state.
                            DashKey.WEEKLY_CAPACITY -> DenPanel(
                                title = "Weekly capacity",
                                subtitle = "This week's visits vs your busiest recent week.",
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                if (state.isLoading) EmptyHint("Loading visits…")
                                else WeeklyCapacityWidget(state.allSessions, java.time.LocalDate.now().toString())
                            }
                            DashKey.OVERDUE_TRACKER -> DenPanel(
                                title = "Overdue visits",
                                subtitle = "Past their end time and not marked complete.",
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                if (state.isLoading) EmptyHint("Loading visits…")
                                else OverdueVisitsWidget(state.allSessions, java.time.LocalDate.now().toString())
                            }
                            DashKey.PET_BREAKDOWN -> DenPanel(
                                title = "Pets by type",
                                subtitle = "Who's in the pack, by species.",
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                if (state.isLoading) EmptyHint("Loading the pack…")
                                else PetBreakdownWidget(state.kin)
                            }
                            DashKey.FREQUENT_FLYERS -> DenPanel(
                                title = "Frequent flyers",
                                subtitle = "Your most-visited households over the last 90 days.",
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                if (state.isLoading) EmptyHint("Loading visits…")
                                else FrequentFlyersWidget(state.allSessions, java.time.LocalDate.now().toString())
                            }
                            DashKey.HOLIDAY_RUNWAY -> DenPanel(
                                title = "Holiday runway",
                                subtitle = "The next big pet-care holidays and what's already booked.",
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                if (state.isLoading) EmptyHint("Loading visits…")
                                else HolidayRunwayWidget(state.allSessions, java.time.LocalDate.now().toString())
                            }
                        }
                        }
                    }
                }
            }

            // 17.3: in edit mode, offer hidden cards for re-adding.
            if (editing) {
                val hidden = hiddenKeys(dashboard)
                if (hidden.isNotEmpty()) {
                    item(key = "dash_hidden") {
                        DenPanel(title = "Hidden cards", subtitle = "Add a card back to your dashboard.") {
                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                hidden.forEach { k ->
                                    GhostButton(
                                        label = dashLabel(k),
                                        onClick = { viewModel.saveDashboard(showWidget(dashboard, k).toTokens()) },
                                        modifier = Modifier.fillMaxWidth(),
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }

        }
        }
    }
    }
}

/** Human label for a dashboard widget key (17.3 edit chrome + hidden strip). */
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

/** Load / error (fail-loud) / ready states for a weather widget. */
@Composable
private fun WeatherWidgetBody(
    state: Result<com.tribetails.auntieos.data.model.LocalWeather>?,
    content: @Composable (com.tribetails.auntieos.data.model.LocalWeather) -> Unit,
) {
    when {
        state == null -> EmptyHint("Loading weather…")
        state.isFailure -> {
            val msg = state.exceptionOrNull()?.message.orEmpty()
            val shown = if (msg.contains("weather_location_not_set")) {
                "Set your weather area (city, metro, or ZIP) in Settings to enable weather."
            } else {
                "Couldn't load weather: ${msg.ifBlank { "unknown error" }}"
            }
            EmptyHint(shown)
        }
        else -> content(state.getOrThrow())
    }
}

@Composable
private fun WeatherHeadRow(w: com.tribetails.auntieos.data.model.LocalWeather) {
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

@Composable
private fun WeatherKeyValueRow(label: String, value: String) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textDim)
        Text(value, style = AuntieTheme.typography.titleMedium, color = AuntieTheme.colors.textPrimary)
    }
}

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

/** 17.3 edit-mode header on each dashboard widget: reorder / hide (phone has no resize). */
@Composable
private fun WidgetEditBar(
    label: String,
    canMoveUp: Boolean,
    canMoveDown: Boolean,
    onUp: () -> Unit,
    onDown: () -> Unit,
    onHide: () -> Unit,
) {
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(c.surface)
            .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(12.dp))
            .padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(label, style = AuntieTheme.typography.labelSmall, color = c.textPrimary, modifier = Modifier.weight(1f))
        EditCtl(Lucide.ArrowUp, "Move $label up", canMoveUp, onUp)
        EditCtl(Lucide.ArrowDown, "Move $label down", canMoveDown, onDown)
        EditCtl(Lucide.EyeOff, "Hide $label", true, onHide)
    }
}

@Composable
private fun EditCtl(icon: ImageVector, desc: String, enabled: Boolean, onClick: () -> Unit) {
    val c = AuntieTheme.colors
    Box(
        modifier = Modifier
            .size(32.dp)
            .clip(RoundedCornerShape(8.dp))
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier)
            .alpha(if (enabled) 1f else 0.35f),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = desc, tint = c.textDim, modifier = Modifier.size(18.dp))
    }
}

/** One labelled money row for the Cash Flow widget (mirror of web CashFlowRow). */
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

/**
 * One Gatekeeper household row: name + days since the last completed visit,
 * tinted by urgency (>=14d red with a pulsing dot, >=7d orange, else green).
 */
@Composable
private fun GatekeeperRow(gap: com.tribetails.auntieos.domain.HouseholdGap) {
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

/** Compact USD label with cents for the Cash Flow rows, e.g. 1280.5 -> "$1280.50". Pure. */
internal fun formatMoney(amount: Double): String {
    val rounded = kotlin.math.round(amount * 100.0) / 100.0
    val whole = rounded.toLong()
    val cents = kotlin.math.round((rounded - whole) * 100.0).toInt()
    return if (cents == 0) "$$whole" else "$$whole.${cents.toString().padStart(2, '0')}"
}

/** Compact USD label for the weekly-revenue tile, e.g. 1280.0 -> "$1,280". Pure. */
internal fun formatRevenue(amount: Double): String {
    val rounded = kotlin.math.round(amount).toLong()
    val grouped = rounded.toString().reversed().chunked(3).joinToString(",").reversed()
    return "$$grouped"
}

@Composable
fun OfflineBanner(
    message: String = "AuntieOS is offline. Check the tunnel.",
    onRetry: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(AuntieTheme.colors.error.copy(alpha = 0.12f))
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        Text(
            message,
            color = AuntieTheme.colors.error,
            style = AuntieTheme.typography.bodySmall,
            modifier = Modifier.weight(1f)
        )
        AuntieIconBtn(onClick = onRetry) {
            Icon(Lucide.RotateCcw, contentDescription = "Retry", tint = AuntieTheme.colors.error)
        }
    }
}

/** A KinTales-pending tale row: colored mark, type + recipient, mono meta line. */
@Composable
private fun TaleRow(draft: Draft, index: Int) {
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
            // item 6: meta = STATUS · household (name once now) · createdOn when present.
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

@Composable
private fun TodayVisitCardView(
    card: TodayVisitCard,
    defaultEtaMinutes: Int,
    etaOptions: List<Int>,
    actionPending: Boolean,
    onMyWay: (Int) -> Unit,
    onArrived: () -> Unit,
    onDeparted: () -> Unit,
    onWriteKinTale: () -> Unit,
    onComplete: () -> Unit,
    onLiveTrack: () -> Unit = {},
    onViewRoute: () -> Unit = {},
) {
    val session = card.session
    val status = runCatching { VisitStatus.valueOf(session.status) }.getOrDefault(VisitStatus.SCHEDULED)
    val kinName = card.kinfolk?.displayName ?: session.kinfolkName.ifBlank { "Unknown kinfolk" }
    val tone = serviceTone(session.serviceType)

    var etaMinutes by remember(session.id) { mutableStateOf(defaultEtaMinutes) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(13.dp))
            .background(AuntieTheme.colors.surfaceGlass)
            .border(AuntieTheme.dims.borderHairline, statusColor(status).copy(alpha = 0.4f), RoundedCornerShape(13.dp))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        // Header row: paw avatar + name/service, service pill, time + status
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(13.dp)) {
            AuntieIconTile(icon = Lucide.PawPrint, tone = tone, size = 38.dp)
            Column(modifier = Modifier.weight(1f)) {
                Text(kinName, style = AuntieTheme.typography.titleSmall, color = AuntieTheme.colors.textPrimary)
                Text(
                    session.serviceType.ifBlank { "Visit" },
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim
                )
            }
            ServicePill(session.serviceType, tone)
            Spacer(Modifier.width(4.dp))
            Column(horizontalAlignment = Alignment.End) {
                Text(formatTime(session.startTime), style = AuntieTheme.typography.titleSmall, color = AuntieTheme.colors.textPrimary)
                Text(statusLabel(session.status), style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
            }
        }

        // Notes
        val noteText = listOfNotNull(
            session.notes.takeIf { it.isNotBlank() },
            session.kinfolkNotes.takeIf { it.isNotBlank() }?.let { "From kinfolk: $it" }
        ).joinToString("\n")
        if (noteText.isNotBlank()) {
            Text(noteText, style = AuntieTheme.typography.bodySmall)
        }

        // ETA dropdown (visible until ARRIVED)
        if (status == VisitStatus.SCHEDULED || status == VisitStatus.ON_MY_WAY) {
            AuntieDropdownField(
                value = etaMinutes,
                options = etaOptions,
                onSelect = { etaMinutes = it },
                displayText = { "$it min" },
                label = "ETA",
                modifier = Modifier.fillMaxWidth(),
                enabled = !actionPending,
            )
        }

        // Lifecycle buttons. Each button is enabled only at the appropriate stage.
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            LifecycleButton(
                label = "On My Way",
                icon = Lucide.Car,
                enabled = !actionPending && status == VisitStatus.SCHEDULED,
                onClick = { onMyWay(etaMinutes) }
            )
            LifecycleButton(
                label = "Arrived",
                icon = Lucide.MapPin,
                enabled = !actionPending && (status == VisitStatus.SCHEDULED || status == VisitStatus.ON_MY_WAY),
                onClick = onArrived
            )
            LifecycleButton(
                label = "Departed",
                icon = Lucide.House,
                enabled = !actionPending && status == VisitStatus.ARRIVED,
                onClick = onDeparted
            )
            // KinTale entry. Only appears once kin care has actually started (Arrived).
            // Hidden (not disabled) before that, per Auntie's UX direction.
            val canWriteKinTale = status == VisitStatus.ARRIVED ||
                status == VisitStatus.DEPARTED ||
                status == VisitStatus.COMPLETED
            if (canWriteKinTale) {
                LifecycleButton(
                    label = if (session.sentReportCount > 0) "Start another KinTale Update" else "Start KinTale Update",
                    icon = Lucide.Pencil,
                    enabled = !actionPending,
                    onClick = onWriteKinTale
                )
            }
            LifecycleButton(
                label = "Complete",
                icon = Lucide.CircleCheckBig,
                enabled = !actionPending && status == VisitStatus.DEPARTED && session.autoCompleteEligible,
                onClick = onComplete
            )

            // Location tools. Visible while session is active or has a saved route.
            val isActive = status == VisitStatus.ARRIVED
            val hasRoute = session.visitRouteId.isNotBlank()
            if (isActive) {
                LifecycleButton(
                    label = "Live tracking",
                    icon = Lucide.MapPin,
                    enabled = !actionPending,
                    onClick = onLiveTrack
                )
            }
            if (hasRoute) {
                LifecycleButton(
                    label = "View visit route",
                    icon = Lucide.Car,
                    enabled = !actionPending,
                    onClick = onViewRoute
                )
            }
        }
    }
}

@Composable
private fun LifecycleButton(
    label: String,
    icon: ImageVector,
    enabled: Boolean,
    onClick: () -> Unit
) {
    PrimaryButton(
        label = label,
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth(),
        leading = { Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp)) }
    )
}

@androidx.compose.runtime.Composable
@androidx.compose.runtime.ReadOnlyComposable
private fun statusColor(status: VisitStatus): Color = when (status) {
    VisitStatus.SCHEDULED -> AuntieTheme.colors.kinfolkOrange
    VisitStatus.ON_MY_WAY -> AuntieTheme.colors.kinfolkOrange
    VisitStatus.ARRIVED -> AuntieTheme.colors.success
    VisitStatus.DEPARTED -> AuntieTheme.colors.success
    VisitStatus.COMPLETED -> AuntieTheme.colors.success
    VisitStatus.CANCELLED -> AuntieTheme.colors.error
}
