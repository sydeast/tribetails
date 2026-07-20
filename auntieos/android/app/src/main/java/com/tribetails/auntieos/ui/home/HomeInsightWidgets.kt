package com.tribetails.auntieos.ui.home

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
// ── AO-37 care flags ────────────────────────────────────────────────────────
/**
 * Care Flags (AO-37). Handling notes for every kin on TODAY's schedule: reactive
 * banner, medication/health notes, feeding brand. Joins the already-loaded
 * [sessions] + [kin] in-memory (no callable). Empty is an honest "nothing flagged"
 * state, distinct from still-loading. Logic in DashboardInsights.kt. Mirrors web.
 */
@Composable
internal fun CareFlagsWidget(
    sessions: List<KinCareSession>,
    kin: List<Kin>,
    isLoading: Boolean,
    todayIso: String,
) {
    if (isLoading) {
        InsightHint("Loading today's pack…")
        return
    }
    val flags = careFlags(sessions, kin.associateBy { it.id }, todayIso)
    if (flags.isEmpty()) {
        InsightHint("Nothing flagged on today's visits.")
        return
    }
    val c = AuntieTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        flags.forEach { f ->
            val tone = when (f.kind) {
                "reactive" -> c.error
                "medication" -> c.secondary
                else -> c.primary
            }
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(12.dp))
                    .background(tone.copy(alpha = 0.10f))
                    .padding(horizontal = 12.dp, vertical = 9.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(Modifier.size(width = 4.dp, height = 34.dp).clip(RoundedCornerShape(4.dp)).background(tone))
                Column(Modifier.weight(1f)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(f.kinName, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                        Text(careFlagLabel(f.kind), style = AuntieTheme.typography.labelSmall, color = tone)
                    }
                    Text(f.text, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    if (f.household.isNotBlank()) {
                        Text(f.household, style = AuntieTheme.typography.bodySmall, color = c.textFaint)
                    }
                }
            }
        }
    }
}
private fun careFlagLabel(kind: String): String = when (kind) {
    "reactive" -> "Reactive"
    "medication" -> "Medication"
    "feeding" -> "Feeding"
    else -> kind
}
// ── AO-39 expiration countdown ──────────────────────────────────────────────
/**
 * Expiration Countdown (AO-39). The next 60 days of expiring gate codes, vet
 * records, cards, and licenses via the one-shot listExpirations callable
 * ([state] == null while it loads). Empty (nothing in the window) is a real
 * caught-up state, distinct from a failed load. Logic in DashboardInsights.kt.
 */
@Composable
internal fun ExpirationsWidget(
    state: Result<List<com.tribetails.auntieos.data.model.ExpirationItem>>?,
    todayIso: String,
) {
    when {
        state == null -> InsightHint("Loading expirations…")
        state.isFailure ->
            InsightHint("Couldn't load expirations: ${state.exceptionOrNull()?.message ?: "unknown error"}", error = true)
        else -> {
            val rows = upcomingExpirations(state.getOrDefault(emptyList()), todayIso)
            if (rows.isEmpty()) {
                InsightHint("Nothing expiring in the next 60 days.")
            } else {
                val c = AuntieTheme.colors
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    rows.forEach { r ->
                        val urgent = r.daysUntil <= 7
                        val tone = if (urgent) c.error else c.textPrimary
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(r.label.ifBlank { "(unnamed)" }, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                                Text(
                                    "${r.dateIso} · ${expirationKindLabel(r.kind)}",
                                    style = AuntieTheme.typography.bodySmall,
                                    color = c.textDim,
                                )
                            }
                            Text(
                                if (r.daysUntil == 0) "today" else "${r.daysUntil}d",
                                style = AuntieTheme.typography.titleMedium,
                                color = tone,
                            )
                        }
                    }
                }
            }
        }
    }
}
private fun expirationKindLabel(kind: String): String = when (kind) {
    "gateCode" -> "Gate code"
    "vetRecord" -> "Vet record"
    "card" -> "Card"
    "license" -> "License"
    else -> "Other"
}
// ── AO-40 expense quick-log ─────────────────────────────────────────────────
/**
 * Expense Quick-Log (AO-40). The server's week + month totals as the headline,
 * then the most recent 5 expenses via the one-shot listExpenses callable
 * ([state] == null while it loads). Fail-loud on a failed load. Totals + formatting
 * from DashboardInsights.kt. Mirrors web + React.
 */
@Composable
internal fun ExpenseLogWidget(
    state: Result<com.tribetails.auntieos.data.model.ExpenseSummary>?,
) {
    when {
        state == null -> InsightHint("Loading expenses…")
        state.isFailure ->
            InsightHint("Couldn't load expenses: ${state.exceptionOrNull()?.message ?: "unknown error"}", error = true)
        else -> {
            val summary = state.getOrThrow()
            val c = AuntieTheme.colors
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
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
                    InsightHint("No expenses logged yet.")
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        recent.forEach { e ->
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text(
                                        expenseKindLabel(e.kind) + (if (e.note.isNotBlank()) ": ${e.note}" else ""),
                                        style = AuntieTheme.typography.bodyMedium,
                                        color = c.textPrimary,
                                    )
                                    if (e.occurredAt.isNotBlank()) {
                                        Text(e.occurredAt.take(10), style = AuntieTheme.typography.bodySmall, color = c.textDim)
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
private fun expenseKindLabel(kind: String): String = when (kind) {
    "gas" -> "Gas"
    "parking" -> "Parking"
    "supplies" -> "Supplies"
    else -> "Other"
}
// ── AO-41 supplies tracker ──────────────────────────────────────────────────
/**
 * Supplies Tracker (AO-41). The low-stock count as the headline, then the depleted
 * rows (onHand <= par, most-depleted first) via the one-shot listSupplies callable
 * ([state] == null while it loads). Each row has a "+1" that calls adjustSupply and
 * reloads. Fail-loud on a failed load. Logic in DashboardInsights.kt. Mirrors web.
 */
@Composable
internal fun SuppliesWidget(
    state: Result<com.tribetails.auntieos.data.model.SuppliesResult>?,
    onAdjust: (String) -> Unit,
) {
    when {
        state == null -> InsightHint("Loading supplies…")
        state.isFailure ->
            InsightHint("Couldn't load supplies: ${state.exceptionOrNull()?.message ?: "unknown error"}", error = true)
        else -> {
            val result = state.getOrThrow()
            val low = lowSupplies(result.supplies)
            val c = AuntieTheme.colors
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    if (result.lowCount == 0) "Fully stocked" else "${result.lowCount} low on stock",
                    style = AuntieTheme.typography.titleMedium,
                    color = if (result.lowCount == 0) c.textPrimary else c.error,
                )
                if (low.isEmpty()) {
                    InsightHint("Nothing at or below par.")
                } else {
                    low.forEach { s ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(12.dp))
                                .background(c.error.copy(alpha = 0.08f))
                                .padding(horizontal = 12.dp, vertical = 9.dp),
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(s.name.ifBlank { "(unnamed)" }, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                                Text(
                                    "${s.onHand} / ${s.par} ${s.unit}".trim(),
                                    style = AuntieTheme.typography.bodySmall,
                                    color = c.textDim,
                                )
                            }
                            Box(
                                modifier = Modifier
                                    .clip(RoundedCornerShape(999.dp))
                                    .background(c.primary.copy(alpha = 0.18f))
                                    .clickable { onAdjust(s.id) }
                                    .padding(horizontal = 14.dp, vertical = 6.dp),
                            ) {
                                Text("+1", style = AuntieTheme.typography.labelMedium, color = c.primary)
                            }
                        }
                    }
                }
            }
        }
    }
}
// ── AO-35 route optimizer ───────────────────────────────────────────────────
/**
 * Route Optimizer (AO-35). Total miles + drive time as the headline, the ordered
 * stops (order, household, arrival ETA), and a fail-loud "unroutable" section for
 * households with no service address, via the one-shot optimizeRoute callable
 * ([state] == null while it loads). Formatting from DashboardInsights.kt. Mirrors web.
 */
@Composable
internal fun RouteOptimizerWidget(
    state: Result<com.tribetails.auntieos.data.model.RouteResult>?,
) {
    when {
        state == null -> InsightHint("Optimizing today's route…")
        state.isFailure ->
            InsightHint("Couldn't optimize the route: ${state.exceptionOrNull()?.message ?: "unknown error"}", error = true)
        else -> {
            val route = state.getOrThrow()
            val c = AuntieTheme.colors
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (route.stops.isEmpty() && route.unroutable.isEmpty()) {
                    InsightHint("No visits to route today.")
                } else {
                    Row(horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                        Column {
                            Text("Distance", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                            Text(formatMiles(route.totalMiles), style = AuntieTheme.typography.titleMedium, color = c.textPrimary)
                        }
                        Column {
                            Text("Drive time", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                            Text(formatDuration(route.totalMinutes), style = AuntieTheme.typography.titleMedium, color = c.textPrimary)
                        }
                    }
                    if (route.stops.isNotEmpty()) {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            route.stops.forEach { stop ->
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                ) {
                                    Box(
                                        modifier = Modifier
                                            .size(24.dp)
                                            .clip(CircleShape)
                                            .background(c.primary.copy(alpha = 0.18f)),
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        Text("${stop.order}", style = AuntieTheme.typography.labelMedium, color = c.primary)
                                    }
                                    Column(Modifier.weight(1f)) {
                                        Text(stop.household.ifBlank { "Kinfolk" }, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                                        if (stop.address.isNotBlank()) {
                                            Text(stop.address, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                                        }
                                    }
                                    if (stop.arrivalEta.isNotBlank()) {
                                        Text(stop.arrivalEta, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                                    }
                                }
                            }
                        }
                    }
                    if (route.unroutable.isNotEmpty()) {
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(
                                "${route.unroutable.size} can't be routed",
                                style = AuntieTheme.typography.titleSmall,
                                color = c.error,
                            )
                            route.unroutable.forEach { u ->
                                Text(
                                    "${u.household.ifBlank { "Kinfolk" }}: ${u.reason.ifBlank { "no service address" }}",
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
}
