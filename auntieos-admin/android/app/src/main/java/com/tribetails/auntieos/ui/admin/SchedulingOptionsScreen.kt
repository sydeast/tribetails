package com.tribetails.auntieos.ui.admin

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Icon
import com.tribetails.auntieos.ui.components.AuntieToggle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tribetails.auntieos.data.model.BookingStatus
import com.tribetails.auntieos.data.model.BookingTimeSlot
import com.tribetails.auntieos.data.model.TimeSlotSource
import com.tribetails.auntieos.ui.admin.scheduling.EnhancedSchedulingViewModel
import com.tribetails.auntieos.ui.admin.services.ServiceManagementViewModel
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.theme.AuntieTheme

import java.time.LocalDate
import androidx.compose.ui.unit.dp

private enum class BlockMode(val label: String) {
    WHOLE_DAY("Whole Day"),
    TIME_BLOCK("Time Block"),
    SPECIFIC_TIME("Specific Time")
}

@Composable
fun SchedulingOptionsScreen(
    onBack: () -> Unit,
    schedulingViewModel: EnhancedSchedulingViewModel,
    serviceManagementViewModel: ServiceManagementViewModel,
    onNavigateToServiceManagement: () -> Unit
) {
    val schedulingState by schedulingViewModel.state.collectAsStateWithLifecycle()
    val serviceState by serviceManagementViewModel.state.collectAsStateWithLifecycle()

    var selectedDate by remember { mutableStateOf(LocalDate.now().toString()) }
    var startTime by remember { mutableStateOf("09:00") }
    var endTime by remember { mutableStateOf("17:00") }
    var blockReason by remember { mutableStateOf("Blocked") }
    var blockMode by remember { mutableStateOf(BlockMode.TIME_BLOCK) }

    val blockedDates = schedulingState.timeSlots.filter { !it.isAvailable }

    AuntieScreenScaffold(title = "Scheduling Options", onBack = onBack, imePaddingEnabled = true) {
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            item {
                AuntieCard {
                    GoogleCalendarSyncCard(
                        syncEnabled = true,
                        isSyncing = schedulingState.isLoading,
                        errorMessage = schedulingState.errorMessage,
                        successMessage = schedulingState.calendarSyncMessage,
                        calendarSyncId = schedulingState.businessSettings.calendarSyncId,
                        calendarSyncIdSaved = schedulingState.calendarSyncIdSaved,
                        onSaveCalendarSyncId = { schedulingViewModel.saveCalendarSyncId(it) },
                        onRunSync = { schedulingViewModel.importGoogleBusyEvents() },
                        onDismissError = { schedulingViewModel.clearCalendarSyncFeedback() },
                    )
                }
            }

            item {
                AuntieCard {
                    Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Icon(Lucide.CalendarX, contentDescription = null, tint = AuntieTheme.colors.kinfolkOrange)
                            Text("Block Dates / Times", style = AuntieTheme.typography.titleMedium)
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            BlockMode.entries.forEach { mode ->
                                GhostButton(
                                    label = mode.label,
                                    onClick = { blockMode = mode }
                                )
                            }
                        }
                        AuntieField(
                            value = selectedDate,
                            onValueChange = { selectedDate = it },
                            label = "Date (YYYY-MM-DD)",
                            modifier = Modifier.fillMaxWidth()
                        )
                        AuntieField(
                            value = startTime,
                            onValueChange = { startTime = it },
                            label = "Start Time (HH:mm)",
                            modifier = Modifier.fillMaxWidth()
                        )
                        AuntieField(
                            value = endTime,
                            onValueChange = { endTime = it },
                            label = "End Time (HH:mm)",
                            modifier = Modifier.fillMaxWidth()
                        )
                        AuntieField(
                            value = blockReason,
                            onValueChange = { blockReason = it },
                            label = "Reason",
                            modifier = Modifier.fillMaxWidth()
                        )
                        PrimaryButton(
                            label = "Save Block",
                            onClick = {
                                val date = runCatching { LocalDate.parse(selectedDate) }.getOrNull() ?: LocalDate.now()
                                val (resolvedStart, resolvedEnd) = when (blockMode) {
                                    BlockMode.WHOLE_DAY -> "00:00" to "23:59"
                                    BlockMode.TIME_BLOCK -> startTime.trim() to endTime.trim()
                                    BlockMode.SPECIFIC_TIME -> startTime.trim() to startTime.trim()
                                }
                                schedulingViewModel.blockTimeSlot(date, resolvedStart, resolvedEnd, blockReason.ifBlank { "Blocked" })
                            },
                            modifier = Modifier.fillMaxWidth()
                        )
                    }
                }
            }

            item {
                AuntieCard {
                    Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("Holidays & Special Hours", style = AuntieTheme.typography.titleMedium)

                        Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("Observe US holidays", style = AuntieTheme.typography.bodyMedium)
                            AuntieToggle(
                                checked = schedulingState.businessSettings.observeUsHolidays,
                                onCheckedChange = { enabled ->
                                    schedulingViewModel.updateBusinessSettings { it.copy(observeUsHolidays = enabled) }
                                },
                            )
                        }

                        Text("Special hours source: Business Hours profile", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary)
                        Text("Surcharges available for holiday use: ${serviceState.surcharges.count { it.isActive }}", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.kinfolkOrange)

                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            GhostButton(label = "Create New Surcharge", onClick = onNavigateToServiceManagement)
                            GhostButton(label = "Link Existing Surcharge", onClick = onNavigateToServiceManagement)
                        }
                    }
                }
            }

            item {
                AuntieCard {
                    Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("Current blocked entries", style = AuntieTheme.typography.titleMedium)
                        if (blockedDates.isEmpty()) {
                            Text("No blocked entries yet.", style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary)
                        } else {
                            BlockedEntriesList(
                                entries = blockedDates,
                                onUnblock = { schedulingViewModel.unblockTimeSlot(it) }
                            )
                        }
                    }
                }
            }

            item {
                Spacer(Modifier.height(20.dp))
            }
        }
    }
}

@Composable
private fun BlockedEntriesList(entries: List<BookingTimeSlot>, onUnblock: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        entries.take(20).forEach { slot ->
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("${slot.date} ${slot.startTime}-${slot.endTime} (${slot.notes})", style = AuntieTheme.typography.bodySmall)
                Text(
                    text = if (slot.source == TimeSlotSource.GOOGLE_BUSY_IMPORT) "Google Busy" else "Manual",
                    style = AuntieTheme.typography.labelSmall,
                    color = AuntieTheme.colors.kinfolkOrange
                )
                GhostButton(label = "Unblock", onClick = { onUnblock(slot.id) })
            }
        }
    }
}

/**
 * Slice 8: the Google Calendar Sync card body. Extracted as a stateless,
 * parameter-driven composable so its three states (dark/not-enabled,
 * idle Run Sync, syncing spinner, error banner with the server message) are
 * unit-testable under Robolectric without standing up the full screen + VMs.
 */
@Composable
internal fun GoogleCalendarSyncCard(
    syncEnabled: Boolean,
    isSyncing: Boolean,
    errorMessage: String?,
    successMessage: String?,
    calendarSyncId: String,
    calendarSyncIdSaved: Boolean,
    onSaveCalendarSyncId: (String) -> Unit,
    onRunSync: () -> Unit,
    onDismissError: () -> Unit,
) {
    Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Lucide.RefreshCw, contentDescription = null, tint = AuntieTheme.colors.kinfolkOrange)
            Text("Google Calendar Sync", style = AuntieTheme.typography.titleMedium)
        }
        Text(
            "Workflow: non-app Busy events from Google import as private blocking slots on booking calendar. Admin can edit/remove blocks; kinfolk only see unavailable time.",
            style = AuntieTheme.typography.bodySmall,
            color = AuntieTheme.colors.textPrimary
        )

        // Front-facing Calendar ID setup. Admin enters the shared calendar id here
        // (saved to business_settings.calendarSyncId); the server reads it first and
        // only falls back to the GOOGLE_CALENDAR_ID secret when empty. Auth stays a
        // service account the admin shares the calendar with (no OAuth entry).
        CalendarSyncIdField(
            calendarSyncId = calendarSyncId,
            calendarSyncIdSaved = calendarSyncIdSaved,
            isSaving = isSyncing,
            onSave = onSaveCalendarSyncId,
        )

        if (!syncEnabled) {
            // Server callable not enabled yet (operator must set GOOGLE_CALENDAR_ID
            // + share the calendar, then flip FF_SCHEDULING_SYNC). Ship dark with a
            // visible banner, never a silent no-op button.
            AuntieBanner(
                tone = AuntieBannerTone.Suggestion,
                dashed = true,
                title = "Calendar sync not enabled yet",
                pillLabel = "Suggestion",
            ) {
                Text(
                    "The server-side sync turns on once the shared calendar is configured. Until then this stays read-only.",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim
                )
            }
        } else {
            errorMessage?.let { msg ->
                AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    title = "Calendar sync failed",
                    onDismiss = onDismissError,
                ) {
                    Text(msg, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
                }
            }
            successMessage?.let { msg ->
                Text(msg, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textPrimary)
            }

            if (isSyncing) {
                Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    AuntieSpinner(
                        modifier = Modifier.size(16.dp),
                        strokeWidth = 2.dp,
                        color = AuntieTheme.colors.kinfolkOrange
                    )
                    Spacer(Modifier.width(8.dp))
                    Text("Syncing...", color = AuntieTheme.colors.kinfolkOrange, style = AuntieTheme.typography.bodySmall)
                }
            } else {
                GhostButton(label = "Run Sync", onClick = onRunSync)
            }
        }
    }
}

/**
 * Front-facing Google Calendar ID setup field. The admin types the shared
 * calendar id here and Saves; it persists to business_settings.calendarSyncId
 * (round-trips via AuntieRepository) and the server-side sync reads it first.
 * The hint names the exact service account the admin must share the calendar
 * with. Auth stays a service account, no OAuth/token entry. Stateless/testable:
 * the persisted value seeds the local edit buffer.
 */
@Composable
internal fun CalendarSyncIdField(
    calendarSyncId: String,
    calendarSyncIdSaved: Boolean,
    isSaving: Boolean,
    onSave: (String) -> Unit,
) {
    var draft by remember(calendarSyncId) { mutableStateOf(calendarSyncId) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        AuntieField(
            value = draft,
            onValueChange = { draft = it },
            label = "Google Calendar ID",
            placeholder = "name@group.calendar.google.com",
            enabled = !isSaving,
            modifier = Modifier.fillMaxWidth()
        )
        Text(
            "Share this calendar with auntieos-admin-calendar-sync@auntieos-ttpc.iam.gserviceaccount.com at See only free/busy (hide details), then save the calendar id here.",
            style = AuntieTheme.typography.bodySmall,
            color = AuntieTheme.colors.textDim
        )
        PrimaryButton(
            label = "Save Calendar ID",
            onClick = { onSave(draft) },
            enabled = !isSaving,
            modifier = Modifier.fillMaxWidth()
        )
        if (calendarSyncIdSaved) {
            Text(
                "Calendar ID saved.",
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.kinfolkOrange
            )
        }
    }
}
