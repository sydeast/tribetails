package com.tribetails.auntieos.ui.home

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
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
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.ui.inbox.ConversationSummary
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.CountUpText
import com.tribetails.auntieos.ui.components.PulsingBadge
import com.tribetails.auntieos.ui.components.ServicePill
import com.tribetails.auntieos.ui.components.color
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlin.math.roundToInt

/**
 * AO-24: android parity for the A8 insight widgets. Rendering only; all rules
 * live in DashboardInsights.kt. Ported from the web HomeInsightWidgets.kt and
 * translated to android's component vocabulary. Unlike web, android's Home VM
 * resolves the streams up front, so these take plain lists (the loading/error
 * gate is handled by the Home screen), and DenPanel has no hoverLift.
 */

/** Small empty / fail-loud error line, since android's EmptyHint is private + has no error variant. */
@Composable
internal fun InsightHint(text: String, error: Boolean = false) {
    Text(
        text = text,
        style = AuntieTheme.typography.bodySmall,
        color = if (error) AuntieTheme.colors.error else AuntieTheme.colors.textDim,
    )
}

// ── Weekly capacity ─────────────────────────────────────────────────────────

@Composable
internal fun WeeklyCapacityWidget(sessions: List<KinCareSession>, todayIso: String) {
    val cap = weeklyCapacity(sessions, todayIso)
    if (cap == null) {
        InsightHint("Couldn't read today's date to size the week.", error = true)
        return
    }
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

// ── Overdue visits ──────────────────────────────────────────────────────────

@Composable
internal fun OverdueVisitsWidget(sessions: List<KinCareSession>, nowIso: String) {
    val overdue = overdueVisits(sessions, nowIso)
    if (overdue.isEmpty()) {
        InsightHint("Nothing overdue. Clean slate.")
        return
    }
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
                    Text("ended ${v.endedAt.take(10)}", style = AuntieTheme.typography.bodySmall, color = c.error)
                }
                if (v.serviceType.isNotBlank()) ServicePill(v.serviceType)
            }
        }
        if (overdue.size > 5) {
            Text("and ${overdue.size - 5} more", style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
    }
}

// ── Pets by type ────────────────────────────────────────────────────────────

@Composable
internal fun PetBreakdownWidget(kin: List<Kin>) {
    val slices = speciesBreakdown(kin)
    if (slices.isEmpty()) {
        InsightHint("No active kin yet. Add your first pet to see the mix.")
        return
    }
    val c = AuntieTheme.colors
    val palette = remember(c) { listOf(c.primary, c.accent, c.tertiary, c.success, c.warning, c.secondary) }
    val total = slices.sumOf { it.count }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(20.dp)) {
        SpeciesDonut(slices = slices, total = total, palette = palette)
        Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.weight(1f)) {
            slices.forEachIndexed { i, s ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.size(9.dp).clip(CircleShape).background(palette[i % palette.size]))
                    Text(s.species, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary, modifier = Modifier.weight(1f))
                    Text(s.count.toString(), style = AuntieTheme.typography.titleSmall, color = c.textDim)
                }
            }
        }
    }
}

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

// ── Frequent flyers ─────────────────────────────────────────────────────────

@Composable
internal fun FrequentFlyersWidget(sessions: List<KinCareSession>, todayIso: String) {
    val flyers = frequentFlyers(sessions, todayIso)
    if (flyers.isEmpty()) {
        InsightHint("No completed visits in the last 90 days yet.")
        return
    }
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
                    modifier = Modifier.size(26.dp).clip(CircleShape).background(toneColor.copy(alpha = 0.16f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("${i + 1}", style = AuntieTheme.typography.labelMedium, color = toneColor)
                }
                Text(f.household, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary, modifier = Modifier.weight(1f))
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

// ── Holiday runway ──────────────────────────────────────────────────────────

@Composable
internal fun HolidayRunwayWidget(sessions: List<KinCareSession>, todayIso: String) {
    val runway = holidayRunway(sessions, todayIso)
    if (runway.isEmpty()) {
        InsightHint("Couldn't read today's date to plan the runway.", error = true)
        return
    }
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
// ── AO-38 / W6 unread client messages ─────────────────────────────────────────
/**
 * Unread Client Messages (AO-38 / W6). Reads the one-shot listConversations
 * result ([state] == null while it loads, since it is a callable not a stream)
 * and surfaces the unread threads, newest first, with a headline total. Empty is
 * a real caught-up state, distinct from a failed load (fail-loud InsightHint).
 * Logic lives in DashboardInsights.kt; this only renders. Mirrors web + React.
 */
@Composable
internal fun UnreadMessagesWidget(state: Result<List<ConversationSummary>>?) {
    when {
        state == null -> InsightHint("Loading messages…")
        state.isFailure ->
            InsightHint("Couldn't load messages: ${state.exceptionOrNull()?.message ?: "unknown error"}", error = true)
        else -> {
            val rows = state.getOrDefault(emptyList())
            val total = unreadClientMessageCount(rows)
            if (total == 0) {
                InsightHint("Inbox is all caught up.")
            } else {
                val c = AuntieTheme.colors
                val shown = unreadClientMessages(rows)
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("$total unread", style = AuntieTheme.typography.titleMedium, color = c.textPrimary)
                    shown.forEach { m ->
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
                    if (total > shown.size) {
                        Text(
                            "and ${total - shown.size} more waiting in the inbox",
                            style = AuntieTheme.typography.bodySmall,
                            color = c.textDim,
                        )
                    }
                }
            }
        }
    }
}
// ── AO-36 / W3 key & code safebox ──────────────────────────────────────────────
/**
 * Key & Code Safebox (AO-36 / W3). Shows access notes for the ONE next upcoming
 * visit's household. Joins the already-loaded sessions with a lazily-loaded
 * kinfolk list ([kinfolkResult] null = still loading). Fail-loud on the kinfolk
 * load; honest "not found" if the next visit's household is not in the list.
 * Logic in DashboardInsights.kt. Mirrors web + React.
 */
@Composable
internal fun SafeboxWidget(
    sessions: List<KinCareSession>,
    sessionsLoading: Boolean,
    kinfolkResult: Result<List<Kinfolk>>?,
    nowIso: String,
) {
    when {
        kinfolkResult?.isFailure == true ->
            InsightHint(
                "Couldn't load households: ${kinfolkResult.exceptionOrNull()?.message ?: "unknown error"}",
                error = true,
            )
        sessionsLoading || kinfolkResult == null -> InsightHint("Loading…")
        else -> {
            val next = nextUpcomingSession(sessions, nowIso)
            if (next == null) {
                InsightHint("No upcoming visits on the books.")
            } else {
                val c = AuntieTheme.colors
                val household = kinfolkResult.getOrDefault(emptyList()).firstOrNull { it.id == next.kinfolkId }
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
                    Text(next.startTime.take(10), style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    val lines = household?.let { safeboxAccessLines(it) } ?: emptyList()
                    when {
                        household == null ->
                            InsightHint("Household record not found for this visit.", error = true)
                        lines.isEmpty() ->
                            InsightHint("No access notes on file for this household.")
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
    }
}
