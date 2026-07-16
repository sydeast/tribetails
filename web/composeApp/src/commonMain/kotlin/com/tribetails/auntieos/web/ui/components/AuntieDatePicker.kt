package com.tribetails.auntieos.web.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.ChevronLeft
import com.composables.icons.lucide.ChevronRight
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.web.theme.AuntieTheme
import kotlinx.datetime.LocalDate

/**
 * Wasm-safe replacement for Material3 DatePickerDialog (B1).
 *
 * The Material3 dialog-picker mounts an invisible modal scrim that swallows
 * every pointer event on wasm and freezes the app until reload. This picker is
 * built entirely from primitives over [AuntieDialog] (which floats on a Popup,
 * not a Material3 Dialog) and the pure [monthGrid] matrix, so it renders and
 * accepts taps on web, desktop, and android alike.
 *
 * @param selectedDate the currently-chosen date, highlighted when its month shows.
 * @param today used to default the visible month and ring today's cell.
 * @param onPick fired with the tapped day; the caller closes the dialog.
 */
@Composable
fun AuntieDatePickerDialog(
    visible: Boolean,
    selectedDate: LocalDate?,
    today: LocalDate,
    onPick: (LocalDate) -> Unit,
    onDismiss: () -> Unit,
) {
    if (!visible) return
    val c = AuntieTheme.colors

    val anchor = selectedDate ?: today
    var year by remember(anchor) { mutableStateOf(anchor.year) }
    var month by remember(anchor) { mutableStateOf(anchor.monthNumber) }

    AuntieDialog(
        visible = true,
        title = "Pick a date",
        onDismiss = onDismiss,
        maxWidth = 380.dp,
        footer = { GhostButton(label = "Cancel", onClick = onDismiss) },
    ) {
        // Month navigation: ‹ Month Year ›
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AuntieIconButton(
                icon = Lucide.ChevronLeft,
                contentDescription = "Previous month",
                onClick = { prevMonth(year, month).let { year = it.first; month = it.second } },
                size = 34.dp,
            )
            Text(
                text = "${MONTH_NAMES[month - 1]} $year",
                style = AuntieTheme.typography.bodyMedium,
                color = c.textPrimary,
                textAlign = TextAlign.Center,
                modifier = Modifier.weight(1f),
            )
            AuntieIconButton(
                icon = Lucide.ChevronRight,
                contentDescription = "Next month",
                onClick = { nextMonth(year, month).let { year = it.first; month = it.second } },
                size = 34.dp,
            )
        }

        // Weekday header (Monday-start, matching the Schedule month grid).
        Row(modifier = Modifier.fillMaxWidth()) {
            WEEKDAY_LABELS.forEach { label ->
                Text(
                    text = label,
                    style = AuntieTheme.typography.labelSmall,
                    color = c.textDim,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.weight(1f),
                )
            }
        }

        // Day grid.
        monthGrid(year, month).forEach { week ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                week.forEach { day ->
                    DayCell(
                        day = day,
                        isSelected = day != null && day == selectedDate,
                        isToday = day != null && day == today,
                        onClick = { day?.let(onPick) },
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}

@Composable
private fun DayCell(
    day: LocalDate?,
    isSelected: Boolean,
    isToday: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    Box(
        modifier = modifier
            .aspectRatio(1f)
            .padding(2.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (day == null) return@Box
        val cellBg = if (isSelected) c.primary else Color.Transparent
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(1f)
                .clip(CircleShape)
                .background(cellBg, CircleShape)
                .then(
                    if (isToday && !isSelected) Modifier.border(1.dp, c.accent, CircleShape)
                    else Modifier,
                )
                .clickable(onClick = onClick),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = day.dayOfMonth.toString(),
                style = AuntieTheme.typography.bodyMedium,
                color = if (isSelected) Color.White else c.textPrimary,
            )
        }
    }
}

private val MONTH_NAMES = listOf(
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)

private val WEEKDAY_LABELS = listOf("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
