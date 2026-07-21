package com.tribetails.auntieos.ui.admin.scheduling

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.tribetails.auntieos.data.model.BaseService
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.NewBookingVisit
import com.tribetails.auntieos.ui.components.AuntieCard
import com.tribetails.auntieos.ui.components.AuntieDropdownField
import com.tribetails.auntieos.ui.components.AuntieTextBtn
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

private val WEEKDAY_LABELS = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
private val MINUTE_STEPS = listOf(0, 15, 30, 45)

/**
 * AO-25: admin New-booking-request dialog. Picks a household + service and either
 * several specific (non-consecutive) dates or a weekly recurrence, all at a shared
 * time, then submits via [onCreate] (the VM's createBookingRequest, backed by the
 * createMultiDateBookingRequest callable). The request enters the Incoming-requests
 * queue for approval, NOT the direct enhanced_bookings form.
 *
 * All date math is LOCAL (see [NewBookingMath]); weekdays use the JS/backend
 * convention (0 = Sunday) so [weeklyDays] passes through to the callable unchanged.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewBookingRequestDialog(
    allKinfolk: List<Kinfolk>,
    baseServices: List<BaseService>,
    inFlight: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onCreate: (kinfolkId: String, visits: List<NewBookingVisit>, notes: String?, pattern: String, weeklyDays: List<Int>?) -> Unit,
) {
    val c = AuntieTheme.colors

    var selectedKinfolk by remember { mutableStateOf<Kinfolk?>(null) }
    var selectedService by remember { mutableStateOf<BaseService?>(null) }
    var hour by remember { mutableStateOf(9) }
    var minute by remember { mutableStateOf(0) }
    var weekly by remember { mutableStateOf(false) }

    // Specific-dates mode: a list of chosen dates (shared time).
    var dates by remember { mutableStateOf<List<LocalDate>>(listOf(LocalDate.now().plusDays(1))) }
    // Weekly mode.
    var weeklyStart by remember { mutableStateOf(LocalDate.now().plusDays(1)) }
    var weekdays by remember { mutableStateOf<Set<Int>>(emptySet()) }
    var weeks by remember { mutableStateOf(4) }

    // Which date field a picker is open for: -1 = none, -2 = weekly start, >=0 = dates[index].
    var pickerFor by remember { mutableStateOf(-1) }

    val startTimesMs = if (weekly) {
        NewBookingMath.expandWeekly(weeklyStart, hour, minute, weekdays, weeks)
    } else {
        NewBookingMath.visitMs(dates.map { NewBookingMath.localMs(it, hour, minute) })
    }
    val visitCount = startTimesMs.size
    val canSubmit = selectedKinfolk != null &&
        selectedService != null &&
        visitCount > 0 &&
        NewBookingMath.allInFuture(startTimesMs, System.currentTimeMillis()) &&
        !inFlight

    if (pickerFor != -1) {
        val current = if (pickerFor == -2) weeklyStart else dates.getOrElse(pickerFor) { LocalDate.now() }
        val pickerState = rememberDatePickerState(
            initialSelectedDateMillis = current.atStartOfDay(ZoneId.systemDefault()).toInstant().toEpochMilli(),
        )
        DatePickerDialog(
            onDismissRequest = { pickerFor = -1 },
            confirmButton = {
                AuntieTextBtn(onClick = {
                    val ms = pickerState.selectedDateMillis
                    if (ms != null) {
                        val picked = Instant.ofEpochMilli(ms).atZone(ZoneId.of("UTC")).toLocalDate()
                        if (pickerFor == -2) weeklyStart = picked
                        else dates = dates.toMutableList().also { it[pickerFor] = picked }
                    }
                    pickerFor = -1
                }) { Text("OK") }
            },
            dismissButton = { AuntieTextBtn(onClick = { pickerFor = -1 }) { Text("Cancel") } },
        ) { DatePicker(state = pickerState) }
    }

    Dialog(onDismissRequest = { if (!inFlight) onDismiss() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        AuntieCard(
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
            shape = RoundedCornerShape(20.dp),
            containerColor = c.surface,
        ) {
            LazyColumn(modifier = Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                item {
                    Text("New booking request", style = AuntieTheme.typography.titleLarge, color = c.textPrimary)
                }
                error?.let {
                    item {
                        Text(it, style = AuntieTheme.typography.bodyMedium, color = c.error)
                    }
                }
                item {
                    AuntieDropdownField(
                        value = selectedKinfolk,
                        options = listOf<Kinfolk?>(null) + allKinfolk,
                        onSelect = { selectedKinfolk = it },
                        displayText = { it?.displayName ?: "Select household *" },
                        label = "HOUSEHOLD",
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                item {
                    AuntieDropdownField(
                        value = selectedService,
                        options = listOf<BaseService?>(null) + baseServices,
                        onSelect = { selectedService = it },
                        displayText = { it?.title ?: "Select service *" },
                        label = "SERVICE",
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        AuntieDropdownField(
                            value = hour,
                            options = (0..23).toList(),
                            onSelect = { hour = it },
                            displayText = { String.format("%02d", it) },
                            label = "HOUR",
                            modifier = Modifier.fillMaxWidth(0.5f),
                        )
                        AuntieDropdownField(
                            value = minute,
                            options = MINUTE_STEPS,
                            onSelect = { minute = it },
                            displayText = { String.format("%02d", it) },
                            label = "MINUTE",
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }

                // Mode toggle.
                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        ModeChip("Specific dates", selected = !weekly) { weekly = false }
                        ModeChip("Weekly", selected = weekly) { weekly = true }
                    }
                }

                if (!weekly) {
                    itemsDates(dates) { idx, date ->
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            DateField(date = date, label = "Visit ${idx + 1}", onClick = { pickerFor = idx }, modifier = Modifier.fillMaxWidth(0.8f))
                            GhostButton(
                                label = "Remove",
                                enabled = dates.size > 1,
                                onClick = { dates = dates.filterIndexed { i, _ -> i != idx } },
                                modifier = Modifier.fillMaxWidth(),
                            )
                        }
                    }
                    item {
                        GhostButton(
                            label = "Add another date",
                            onClick = { dates = dates + LocalDate.now().plusDays(1) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                } else {
                    item {
                        DateField(date = weeklyStart, label = "Start on", onClick = { pickerFor = -2 }, modifier = Modifier.fillMaxWidth())
                    }
                    item {
                        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            WEEKDAY_LABELS.forEachIndexed { day, label ->
                                ModeChip(label, selected = day in weekdays) {
                                    weekdays = if (day in weekdays) weekdays - day else weekdays + day
                                }
                            }
                        }
                    }
                    item {
                        AuntieDropdownField(
                            value = weeks,
                            options = (1..12).toList(),
                            onSelect = { weeks = it },
                            displayText = { "$it week${if (it == 1) "" else "s"}" },
                            label = "FOR HOW LONG",
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }

                item {
                    Text(
                        if (visitCount > 0) "$visitCount visit(s) will be requested." else "Pick at least one future date.",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }

                item {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        GhostButton(label = "Cancel", onClick = onDismiss, enabled = !inFlight, modifier = Modifier.fillMaxWidth(0.5f))
                        PrimaryButton(
                            label = if (inFlight) "Creating…" else if (visitCount > 0) "Create $visitCount visit(s)" else "Create request",
                            enabled = canSubmit,
                            onClick = {
                                val kf = selectedKinfolk
                                val svc = selectedService
                                if (kf != null) {
                                    val visits = startTimesMs.map {
                                        NewBookingVisit(
                                            startTimeMs = it,
                                            serviceName = svc?.title ?: "Visit",
                                            serviceId = svc?.id,
                                        )
                                    }
                                    onCreate(
                                        kf.id,
                                        visits,
                                        null,
                                        if (weekly) "weekly" else "individual",
                                        if (weekly) weekdays.sorted() else null,
                                    )
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
        }
    }
}

/** A clickable selection pill (no M3 Checkbox/Chip: those are disallowed visual components). */
@Composable
private fun ModeChip(label: String, selected: Boolean, onClick: () -> Unit) {
    val c = AuntieTheme.colors
    Box(
        modifier = Modifier
            .clickable(onClick = onClick)
            .background(if (selected) c.surface2 else c.surface, RoundedCornerShape(999.dp))
            .border(1.dp, if (selected) c.accent else c.border, RoundedCornerShape(999.dp))
            .padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        Text(label, style = AuntieTheme.typography.bodySmall, color = if (selected) c.textPrimary else c.textDim)
    }
}

/** A read-only field showing a date; tapping opens the date picker. */
@Composable
private fun DateField(date: LocalDate, label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = AuntieTheme.colors
    Box(
        modifier = modifier
            .clickable(onClick = onClick)
            .border(1.dp, c.border, RoundedCornerShape(8.dp))
            .padding(horizontal = 12.dp, vertical = 12.dp),
    ) {
        Text("$label: $date", style = AuntieTheme.typography.bodyMedium, color = c.textPrimary, textAlign = TextAlign.Start)
    }
}

/** LazyListScope helper: one item per date row. */
private fun androidx.compose.foundation.lazy.LazyListScope.itemsDates(
    dates: List<LocalDate>,
    row: @Composable (Int, LocalDate) -> Unit,
) {
    dates.forEachIndexed { idx, date ->
        item(key = "date-$idx") { row(idx, date) }
    }
}
