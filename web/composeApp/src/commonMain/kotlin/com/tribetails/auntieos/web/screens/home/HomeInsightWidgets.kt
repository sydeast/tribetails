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
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.CountUpText
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.EmptyHint
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
