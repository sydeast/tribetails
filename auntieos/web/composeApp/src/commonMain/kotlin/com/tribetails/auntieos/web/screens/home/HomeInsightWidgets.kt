package com.tribetails.auntieos.web.screens.home

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.ExpenseSummary
import com.tribetails.auntieos.web.data.ExpirationItem
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.RouteResult
import com.tribetails.auntieos.web.data.SupplySummary
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.screens.inbox.ConversationSummary
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.CountUpText
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.EmptyHint
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.PulsingBadge
import com.tribetails.auntieos.web.ui.components.ServicePill
import com.tribetails.auntieos.web.ui.components.color
import com.tribetails.auntieos.web.ui.components.formatTime
import kotlin.math.roundToInt

/**
 * A8 insight widgets (W8 Weekly capacity, W9 Overdue visits, W10 Pets by type,
 * W11 Frequent flyers, W13 Holiday runway). Rendering only; every rule lives in
 * DashboardInsights.kt so the JVM tests pin behavior. All five ship hidden by
 * default (Customize > Hidden cards) and follow the Den widget contract:
 * DenPanel(hoverLift = true), EmptyHint loading, EmptyHint(error = true) fail-loud.
 */

// ── shared plumbing ───────────────────────────────────────────────────────────

/** Loading / fail-loud error gate shared by the session-driven insight widgets. */
@Composable
private fun SessionsGate(
    state: FirestoreResult<List<KinCareSession>>,
    ready: @Composable (List<KinCareSession>) -> Unit,
) {
    when (state) {
        is FirestoreResult.Loading -> EmptyHint("Loading visits…")
        is FirestoreResult.Error -> EmptyHint("Couldn't load visits: ${state.message}", error = true)
        is FirestoreResult.Data -> ready(state.value)
    }
}

// ── W8 weekly capacity ────────────────────────────────────────────────────────

@Composable
internal fun WeeklyCapacityWidget(sessionsState: FirestoreResult<List<KinCareSession>>, todayIso: String) {
    DenPanel(
        title = "Weekly capacity",
        subtitle = "This week's visits vs your busiest recent week.",
        modifier = Modifier.fillMaxWidth(),
        hoverLift = true,
    ) {
        SessionsGate(sessionsState) { sessions ->
            val cap = weeklyCapacity(sessions, todayIso)
            if (cap == null) {
                EmptyHint("Couldn't read today's date to size the week.", error = true)
            } else {
                val c = AuntieTheme.colors
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        CountUpText(
                            target = cap.booked.toDouble(),
                            format = { it.roundToInt().toString() },
                            style = AuntieTheme.typography.headlineLarge,
                            color = c.textPrimary,
                        )
                        Text(
                            "of ${cap.capacity} visits",
                            style = AuntieTheme.typography.bodyMedium,
                            color = c.textDim,
                            modifier = Modifier.padding(bottom = 4.dp),
                        )
                    }
                    CapacityBar(fraction = cap.fraction)
                    Text(
                        when {
                            cap.beatingRecord -> "Busiest week on your books. Pace yourself."
                            cap.record == 0 -> "No recent weeks to compare yet."
                            else -> "Your busiest of the last 4 weeks hit ${cap.record}."
                        },
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }
            }
        }
    }
}

/** Rounded track + fill; the fill animates from 0 to [fraction] on load. */
@Composable
private fun CapacityBar(fraction: Float) {
    val c = AuntieTheme.colors
    val anim = remember(fraction) { Animatable(0f) }
    LaunchedEffect(fraction) {
        anim.animateTo(fraction, animationSpec = tween(durationMillis = 800, easing = FastOutSlowInEasing))
    }
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(10.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(c.border.copy(alpha = 0.5f)),
    ) {
        if (anim.value > 0f) {
            Box(
                modifier = Modifier
                    .fillMaxWidth(anim.value)
                    .fillMaxHeight()
                    .clip(RoundedCornerShape(999.dp))
                    .background(if (fraction >= 1f) c.warning else c.primary),
            )
        }
    }
}

// ── W9 overdue visits ─────────────────────────────────────────────────────────

@Composable
internal fun OverdueVisitsWidget(sessionsState: FirestoreResult<List<KinCareSession>>, nowIso: String) {
    DenPanel(
        title = "Overdue visits",
        subtitle = "Past their end time and not marked complete.",
        modifier = Modifier.fillMaxWidth(),
        hoverLift = true,
    ) {
        SessionsGate(sessionsState) { sessions ->
            val overdue = overdueVisits(sessions, nowIso)
            if (overdue.isEmpty()) {
                EmptyHint("Nothing overdue. Clean slate.")
            } else {
                val c = AuntieTheme.colors
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    overdue.take(5).forEach { v ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(12.dp))
                                .background(c.error.copy(alpha = 0.10f))
                                .padding(horizontal = 12.dp, vertical = 9.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            PulsingBadge(color = c.error, size = 9.dp)
                            Column(Modifier.weight(1f)) {
                                Text(v.kinfolkName, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                                Text(
                                    "ended ${v.endedAt.take(10)} ${formatTime(v.endedAt)}".trim(),
                                    style = AuntieTheme.typography.bodySmall,
                                    color = c.error,
                                )
                            }
                            if (v.serviceType.isNotBlank()) ServicePill(v.serviceType)
                        }
                    }
                    if (overdue.size > 5) {
                        Text(
                            "and ${overdue.size - 5} more",
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textDim,
                        )
                    }
                }
            }
        }
    }
}

// ── W10 pets by type ──────────────────────────────────────────────────────────

@Composable
internal fun PetBreakdownWidget(kinState: FirestoreResult<List<Kin>>) {
    DenPanel(
        title = "Pets by type",
        subtitle = "Who's in the pack, by species.",
        modifier = Modifier.fillMaxWidth(),
        hoverLift = true,
    ) {
        when (kinState) {
            is FirestoreResult.Loading -> EmptyHint("Loading the pack…")
            is FirestoreResult.Error -> EmptyHint("Couldn't load pets: ${kinState.message}", error = true)
            is FirestoreResult.Data -> {
                val slices = speciesBreakdown(kinState.value)
                if (slices.isEmpty()) {
                    EmptyHint("No active kin yet. Add your first pet to see the mix.")
                } else {
                    val c = AuntieTheme.colors
                    val palette = remember(c) {
                        listOf(c.primary, c.accent, c.tertiary, c.success, c.warning, c.secondary)
                    }
                    val total = slices.sumOf { it.count }
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(20.dp),
                    ) {
                        SpeciesDonut(slices = slices, total = total, palette = palette)
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.weight(1f)) {
                            slices.forEachIndexed { i, s ->
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    Box(
                                        Modifier
                                            .size(9.dp)
                                            .clip(CircleShape)
                                            .background(palette[i % palette.size]),
                                    )
                                    Text(
                                        s.species,
                                        style = AuntieTheme.typography.bodyMedium,
                                        color = c.textPrimary,
                                        modifier = Modifier.weight(1f),
                                    )
                                    Text(
                                        s.count.toString(),
                                        style = AuntieTheme.typography.titleSmall,
                                        color = c.textDim,
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

/** Donut drawn with plain Canvas arcs; sweep animates in and the center total rolls up. */
@Composable
private fun SpeciesDonut(slices: List<SpeciesSlice>, total: Int, palette: List<Color>) {
    val c = AuntieTheme.colors
    val sweep = remember(total) { Animatable(0f) }
    LaunchedEffect(total) {
        sweep.animateTo(1f, animationSpec = tween(durationMillis = 900, easing = FastOutSlowInEasing))
    }
    Box(contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(128.dp)) {
            val stroke = Stroke(width = 20.dp.toPx(), cap = StrokeCap.Butt)
            val inset = stroke.width / 2f
            val arcSize = Size(size.width - stroke.width, size.height - stroke.width)
            var start = -90f
            slices.forEachIndexed { i, s ->
                val fullSweep = 360f * s.count / total
                val gap = if (slices.size > 1) 2f else 0f
                drawArc(
                    color = palette[i % palette.size],
                    startAngle = start,
                    sweepAngle = ((fullSweep - gap) * sweep.value).coerceAtLeast(0f),
                    useCenter = false,
                    topLeft = Offset(inset, inset),
                    size = arcSize,
                    style = stroke,
                )
                start += fullSweep
            }
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            CountUpText(
                target = total.toDouble(),
                format = { it.roundToInt().toString() },
                style = AuntieTheme.typography.headlineLarge,
                color = c.textPrimary,
            )
            Text("active kin", style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
    }
}

// ── W11 frequent flyers ───────────────────────────────────────────────────────

@Composable
internal fun FrequentFlyersWidget(sessionsState: FirestoreResult<List<KinCareSession>>, todayIso: String) {
    DenPanel(
        title = "Frequent flyers",
        subtitle = "Your most-visited households over the last 90 days.",
        modifier = Modifier.fillMaxWidth(),
        hoverLift = true,
    ) {
        SessionsGate(sessionsState) { sessions ->
            val flyers = frequentFlyers(sessions, todayIso)
            if (flyers.isEmpty()) {
                EmptyHint("No completed visits in the last 90 days yet.")
            } else {
                val c = AuntieTheme.colors
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    flyers.forEachIndexed { i, f ->
                        val tone = when (i) {
                            0 -> AuntieStatusTone.Orange
                            1 -> AuntieStatusTone.Teal
                            2 -> AuntieStatusTone.Purple
                            else -> AuntieStatusTone.Muted
                        }
                        val toneColor = tone.color(c)
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(26.dp)
                                    .clip(CircleShape)
                                    .background(toneColor.copy(alpha = 0.16f)),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text("${i + 1}", style = AuntieTheme.typography.labelMedium, color = toneColor)
                            }
                            Text(
                                f.household,
                                style = AuntieTheme.typography.bodyMedium,
                                color = c.textPrimary,
                                modifier = Modifier.weight(1f),
                            )
                            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                CountUpText(
                                    target = f.visits.toDouble(),
                                    format = { it.roundToInt().toString() },
                                    style = AuntieTheme.typography.titleMedium,
                                    color = toneColor,
                                )
                                Text("visits", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                            }
                        }
                    }
                }
            }
        }
    }
}

// ── W13 holiday runway ────────────────────────────────────────────────────────

@Composable
internal fun HolidayRunwayWidget(sessionsState: FirestoreResult<List<KinCareSession>>, todayIso: String) {
    DenPanel(
        title = "Holiday runway",
        subtitle = "The next big pet-care holidays and what's already booked.",
        modifier = Modifier.fillMaxWidth(),
        hoverLift = true,
    ) {
        SessionsGate(sessionsState) { sessions ->
            val runway = holidayRunway(sessions, todayIso)
            if (runway.isEmpty()) {
                EmptyHint("Couldn't read today's date to plan the runway.", error = true)
            } else {
                val c = AuntieTheme.colors
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    runway.forEach { h ->
                        val soon = h.daysUntil <= 7
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            if (soon) PulsingBadge(color = c.primary, size = 8.dp)
                            Column(Modifier.weight(1f)) {
                                Text(h.name, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                                Text(h.dateIso, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                            }
                            Column(horizontalAlignment = Alignment.End) {
                                Text(
                                    when (h.daysUntil) {
                                        0 -> "today"
                                        1 -> "tomorrow"
                                        else -> "in ${h.daysUntil} days"
                                    },
                                    style = AuntieTheme.typography.titleSmall,
                                    color = if (soon) c.primary else c.textPrimary,
                                )
                                Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                                    CountUpText(
                                        target = h.bookedVisits.toDouble(),
                                        format = { it.roundToInt().toString() },
                                        style = AuntieTheme.typography.bodySmall,
                                        color = c.textDim,
                                    )
                                    Text("booked", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
// ── AO-38 / W6 unread client messages ─────────────────────────────────────────
/**
 * Unread Client Messages (AO-38 / W6). Reads the one-shot `listConversations`
 * result ([state] == null while it loads, since it is a callable not a stream)
 * and surfaces the unread threads, newest first, with a headline total. Empty is
 * a real caught-up state, distinct from a failed load. Logic lives in
 * DashboardInsights.kt; this only renders. Mirrors the React UnreadMessagesWidget.
 */
@Composable
internal fun UnreadMessagesWidget(state: WriteResult<List<ConversationSummary>>?) {
    DenPanel(
        title = "Unread client messages",
        subtitle = "Threads waiting on a reply, newest first.",
        modifier = Modifier.fillMaxWidth(),
        hoverLift = true,
    ) {
        when (state) {
            null -> EmptyHint("Loading messages…")
            is WriteResult.Err -> EmptyHint("Couldn't load messages: ${state.message}", error = true)
            is WriteResult.Ok -> {
                val total = unreadClientMessageCount(state.value)
                if (total == 0) {
                    EmptyHint("Inbox is all caught up.")
                } else {
                    val c = AuntieTheme.colors
                    val rows = unreadClientMessages(state.value)
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            "$total unread",
                            style = AuntieTheme.typography.titleMedium,
                            color = c.textPrimary,
                        )
                        rows.forEach { m ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(12.dp))
                                    .background(c.primary.copy(alpha = 0.08f))
                                    .padding(horizontal = 12.dp, vertical = 9.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                PulsingBadge(color = c.primary, size = 9.dp)
                                Column(Modifier.weight(1f)) {
                                    Text(m.household, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                                    Text(
                                        m.preview.ifBlank { "(no preview)" },
                                        style = AuntieTheme.typography.bodySmall,
                                        color = c.textDim,
                                    )
                                }
                            }
                        }
                        if (total > rows.size) {
                            Text(
                                "and ${total - rows.size} more waiting in the inbox",
                                style = AuntieTheme.typography.bodySmall,
                                color = c.textDim,
                            )
                        }
                    }
                }
            }
        }
    }
}
// ── AO-36 / W3 key & code safebox ──────────────────────────────────────────────
/**
 * Key & Code Safebox (AO-36 / W3). Joins the sessions + kinfolk streams (both
 * already live on Home) to show the access notes for the ONE next upcoming
 * visit's household. Fail-loud on either stream's error; honest "not found" if
 * the next visit's household is not in the (active) kinfolk list. Logic in
 * DashboardInsights.kt. Mirrors the React SafeboxWidget.
 */
@Composable
internal fun SafeboxWidget(
    sessionsState: FirestoreResult<List<KinCareSession>>,
    kinfolkState: FirestoreResult<List<Kinfolk>>,
    nowIso: String,
) {
    DenPanel(
        title = "Key & code safebox",
        subtitle = "Access notes for your next visit only.",
        modifier = Modifier.fillMaxWidth(),
        hoverLift = true,
    ) {
        when {
            sessionsState is FirestoreResult.Error ->
                EmptyHint("Couldn't load visits: ${sessionsState.message}", error = true)
            kinfolkState is FirestoreResult.Error ->
                EmptyHint("Couldn't load households: ${kinfolkState.message}", error = true)
            sessionsState is FirestoreResult.Data && kinfolkState is FirestoreResult.Data -> {
                val next = nextUpcomingSession(sessionsState.value, nowIso)
                if (next == null) {
                    EmptyHint("No upcoming visits on the books.")
                } else {
                    val c = AuntieTheme.colors
                    val household = kinfolkState.value.firstOrNull { it._id == next.kinfolkId }
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(
                                next.kinfolkName.ifBlank { "Kinfolk" },
                                style = AuntieTheme.typography.titleMedium,
                                color = c.textPrimary,
                            )
                            if (next.serviceType.isNotBlank()) ServicePill(next.serviceType)
                        }
                        Text(
                            "${next.startTime.take(10)} ${formatTime(next.startTime)}".trim(),
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textDim,
                        )
                        val lines = household?.let { safeboxAccessLines(it) } ?: emptyList()
                        when {
                            household == null ->
                                EmptyHint("Household record not found for this visit.", error = true)
                            lines.isEmpty() ->
                                EmptyHint("No access notes on file for this household.")
                            else -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                lines.forEach { line ->
                                    Column {
                                        Text(line.label, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                                        Text(
                                            line.value,
                                            style = AuntieTheme.typography.bodyMedium,
                                            color = if (line.mono) c.primary else c.textPrimary,
                                        )
                                    }
                                }
                            }
                        }
                    }
                }
            }
            else -> EmptyHint("Loading…")
        }
    }
}
// ── AO-37 care flags ───────────────────────────────────────────────────────────
/**
 * Care Flags (AO-37). Joins today's sessions + the kin stream (no callable) and
 * surfaces the reactive / medication / feeding alerts the operator needs before a
 * visit. Fail-loud on either stream's error; a real empty ("nothing to flag") is
 * distinct from a failed load. Logic in DashboardInsights.kt. Mirrors the React
 * CareFlagsWidget.
 */
@Composable
internal fun CareFlagsWidget(
    sessionsState: FirestoreResult<List<KinCareSession>>,
    kinState: FirestoreResult<List<Kin>>,
    todayIso: String,
) {
    DenPanel(
        title = "Care flags",
        subtitle = "Medication, feeding, and handle-with-care notes for today.",
        modifier = Modifier.fillMaxWidth(),
        hoverLift = true,
    ) {
        when {
            sessionsState is FirestoreResult.Error ->
                EmptyHint("Couldn't load visits: ${sessionsState.message}", error = true)
            kinState is FirestoreResult.Error ->
                EmptyHint("Couldn't load kin: ${kinState.message}", error = true)
            sessionsState is FirestoreResult.Data && kinState is FirestoreResult.Data -> {
                val kinById = kinState.value.associateBy { it._id }
                val flags = careFlags(sessionsState.value, kinById, todayIso)
                if (flags.isEmpty()) {
                    EmptyHint("No care flags on today's visits.")
                } else {
                    val c = AuntieTheme.colors
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        flags.forEach { f ->
                            val tone = when (f.kind) {
                                "reactive" -> c.error
                                "medication" -> c.warning
                                else -> c.primary
                            }
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(12.dp))
                                    .background(tone.copy(alpha = 0.10f))
                                    .padding(horizontal = 12.dp, vertical = 9.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                PulsingBadge(color = tone, size = 9.dp)
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        "${f.kinName} · ${f.household}",
                                        style = AuntieTheme.typography.titleSmall,
                                        color = c.textPrimary,
                                    )
                                    Text(
                                        f.text,
                                        style = AuntieTheme.typography.bodySmall,
                                        color = c.textDim,
                                    )
                                }
                                ServicePill(careFlagKindLabel(f.kind))
                            }
                        }
                    }
                }
            }
            else -> EmptyHint("Loading…")
        }
    }
}

private fun careFlagKindLabel(kind: String): String = when (kind) {
    "reactive" -> "Reactive"
    "medication" -> "Meds"
    "feeding" -> "Feeding"
    else -> kind
}
// ── AO-39 expiration countdown ─────────────────────────────────────────────────
/**
 * Expiration Countdown (AO-39). Reads the one-shot `listExpirations` result
 * ([state] == null while it loads) and shows what expires within 60 days, soonest
 * first, with a days-until countdown. Empty is a real caught-up state. Logic in
 * DashboardInsights.kt. Mirrors the React ExpirationsWidget.
 */
@Composable
internal fun ExpirationsWidget(state: WriteResult<List<ExpirationItem>>?, todayIso: String) {
    DenPanel(
        title = "Expiration countdown",
        subtitle = "Gate codes, vet records, and cards expiring soon.",
        modifier = Modifier.fillMaxWidth(),
        hoverLift = true,
    ) {
        when (state) {
            null -> EmptyHint("Loading reminders…")
            is WriteResult.Err -> EmptyHint("Couldn't load reminders: ${state.message}", error = true)
            is WriteResult.Ok -> {
                val rows = upcomingExpirations(state.value, todayIso)
                if (rows.isEmpty()) {
                    EmptyHint("Nothing expiring in the next 60 days.")
                } else {
                    val c = AuntieTheme.colors
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        rows.forEach { r ->
                            val urgent = r.daysUntil <= 7
                            val tone = if (urgent) c.warning else c.primary
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(12.dp))
                                    .background(tone.copy(alpha = 0.08f))
                                    .padding(horizontal = 12.dp, vertical = 9.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text(r.label.ifBlank { "(unlabeled)" }, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                                    Text(r.dateIso, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                                }
                                Text(
                                    countdownLabel(r.daysUntil),
                                    style = AuntieTheme.typography.titleSmall,
                                    color = tone,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun countdownLabel(daysUntil: Int): String = when {
    daysUntil <= 0 -> "today"
    daysUntil == 1 -> "1 day"
    else -> "$daysUntil days"
}
// ── AO-40 expense quick-log ────────────────────────────────────────────────────
/**
 * Expense Quick-Log (AO-40). Reads the one-shot `listExpenses` result ([state] ==
 * null while it loads) and shows the server-computed week + month totals plus the
 * 5 most recent expenses. Logic in DashboardInsights.kt. Mirrors the React
 * ExpenseLogWidget.
 */
@Composable
internal fun ExpenseLogWidget(state: WriteResult<ExpenseSummary>?) {
    DenPanel(
        title = "Expense quick-log",
        subtitle = "Gas, parking, and supplies, this week and month.",
        modifier = Modifier.fillMaxWidth(),
        hoverLift = true,
    ) {
        when (state) {
            null -> EmptyHint("Loading expenses…")
            is WriteResult.Err -> EmptyHint("Couldn't load expenses: ${state.message}", error = true)
            is WriteResult.Ok -> {
                val c = AuntieTheme.colors
                val summary = state.value
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                        Column {
                            Text("This week", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                            Text(formatCents(summary.weekTotalCents), style = AuntieTheme.typography.titleMedium, color = c.textPrimary)
                        }
                        Column {
                            Text("This month", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                            Text(formatCents(summary.monthTotalCents), style = AuntieTheme.typography.titleMedium, color = c.textPrimary)
                        }
                    }
                    val recent = recentExpenses(summary.expenses)
                    if (recent.isEmpty()) {
                        EmptyHint("No expenses logged yet.")
                    } else {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            recent.forEach { e ->
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    Column(Modifier.weight(1f)) {
                                        Text(
                                            e.kind.replaceFirstChar { it.uppercase() },
                                            style = AuntieTheme.typography.titleSmall,
                                            color = c.textPrimary,
                                        )
                                        val sub = listOf(e.note.trim(), e.occurredAt.take(10)).filter { it.isNotBlank() }.joinToString(" · ")
                                        if (sub.isNotBlank()) {
                                            Text(sub, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                                        }
                                    }
                                    Text(formatCents(e.amountCents), style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
// ── AO-41 supplies tracker ─────────────────────────────────────────────────────
/**
 * Supplies Tracker (AO-41). Reads the one-shot `listSupplies` result ([state] ==
 * null while it loads), headlines the low count, and lists the most-depleted
 * supplies with an on-hand / par read and a +1 restock control that calls
 * adjustSupply via [onAdjust]. Logic in DashboardInsights.kt. Mirrors the React
 * SuppliesWidget.
 */
@Composable
internal fun SuppliesWidget(state: WriteResult<SupplySummary>?, onAdjust: (String) -> Unit) {
    DenPanel(
        title = "Supplies tracker",
        subtitle = "What's running low against its reorder par.",
        modifier = Modifier.fillMaxWidth(),
        hoverLift = true,
    ) {
        when (state) {
            null -> EmptyHint("Loading supplies…")
            is WriteResult.Err -> EmptyHint("Couldn't load supplies: ${state.message}", error = true)
            is WriteResult.Ok -> {
                val c = AuntieTheme.colors
                val low = lowSupplies(state.value.supplies)
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(
                        if (state.value.lowCount == 0) "Everything's stocked" else "${state.value.lowCount} running low",
                        style = AuntieTheme.typography.titleMedium,
                        color = if (state.value.lowCount == 0) c.textPrimary else c.warning,
                    )
                    if (low.isEmpty()) {
                        EmptyHint("Nothing at or below par.")
                    } else {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            low.forEach { s ->
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clip(RoundedCornerShape(12.dp))
                                        .background(c.warning.copy(alpha = 0.08f))
                                        .padding(horizontal = 12.dp, vertical = 9.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    Column(Modifier.weight(1f)) {
                                        Text(s.name.ifBlank { "(unnamed)" }, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                                        Text(
                                            "${s.onHand} / ${s.par}${if (s.unit.isNotBlank()) " " + s.unit else ""} on hand",
                                            style = AuntieTheme.typography.bodySmall,
                                            color = c.textDim,
                                        )
                                    }
                                    GhostButton(label = "+1", onClick = { onAdjust(s._id) })
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
// ── AO-35 route optimizer ──────────────────────────────────────────────────────
/**
 * Route Optimizer (AO-35). Reads the one-shot `optimizeRoute` result ([state] ==
 * null while it loads): trip totals headline, the ordered stops with arrival ETAs,
 * and a fail-loud "unroutable" section for households with no service address.
 * The optimize itself is server-side (Mapbox); formatting in DashboardInsights.kt.
 * Mirrors the React RouteOptimizerWidget.
 */
@Composable
internal fun RouteOptimizerWidget(state: WriteResult<RouteResult>?) {
    DenPanel(
        title = "Route optimizer",
        subtitle = "Today's visits in the shortest driving order.",
        modifier = Modifier.fillMaxWidth(),
        hoverLift = true,
    ) {
        when (state) {
            null -> EmptyHint("Optimizing today's route…")
            is WriteResult.Err -> EmptyHint("Couldn't optimize route: ${state.message}", error = true)
            is WriteResult.Ok -> {
                val c = AuntieTheme.colors
                val route = state.value
                if (route.stops.isEmpty() && route.unroutable.isEmpty()) {
                    EmptyHint("No visits to route today.")
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(
                            "${formatMiles(route.totalMiles)} · ${formatDuration(route.totalMinutes)}",
                            style = AuntieTheme.typography.titleMedium,
                            color = c.textPrimary,
                        )
                        route.stops.forEach { stop ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(12.dp))
                                    .background(c.primary.copy(alpha = 0.08f))
                                    .padding(horizontal = 12.dp, vertical = 9.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                Text(
                                    "${stop.order}",
                                    style = AuntieTheme.typography.titleMedium,
                                    color = c.primary,
                                )
                                Column(Modifier.weight(1f)) {
                                    Text(stop.household.ifBlank { "Kinfolk" }, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                                    if (stop.address.isNotBlank()) {
                                        Text(stop.address, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                                    }
                                }
                                if (stop.arrivalEta.isNotBlank()) {
                                    Text(stop.arrivalEta, style = AuntieTheme.typography.titleSmall, color = c.textDim)
                                }
                            }
                        }
                        if (route.unroutable.isNotEmpty()) {
                            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text(
                                    "${route.unroutable.size} couldn't be routed",
                                    style = AuntieTheme.typography.titleSmall,
                                    color = c.error,
                                )
                                route.unroutable.forEach { u ->
                                    Row(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .clip(RoundedCornerShape(12.dp))
                                            .background(c.error.copy(alpha = 0.10f))
                                            .padding(horizontal = 12.dp, vertical = 9.dp),
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                                    ) {
                                        PulsingBadge(color = c.error, size = 9.dp)
                                        Column(Modifier.weight(1f)) {
                                            Text(u.household.ifBlank { "Kinfolk" }, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                                            Text(u.reason.ifBlank { "No service address on file." }, style = AuntieTheme.typography.bodySmall, color = c.error)
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
