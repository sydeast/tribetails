package com.tribetails.auntieos.ui.admin

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
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
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.tribetails.auntieos.data.model.BookingStatus
import com.tribetails.auntieos.data.model.BookingTimeSlot
import com.tribetails.auntieos.data.model.TimeSlotSource
import com.tribetails.auntieos.data.repository.GoogleCalendarSummary
import com.tribetails.auntieos.ui.admin.scheduling.BlockMode
import com.tribetails.auntieos.ui.admin.scheduling.CALENDAR_ID_EXAMPLE
import com.tribetails.auntieos.ui.admin.scheduling.CALENDAR_SYNC_SA_EMAIL
import com.tribetails.auntieos.ui.admin.scheduling.CalendarSyncRun
import com.tribetails.auntieos.ui.admin.scheduling.EnhancedSchedulingViewModel
import com.tribetails.auntieos.ui.admin.scheduling.GOOGLE_OAUTH_SECRET_NAMES
import com.tribetails.auntieos.ui.admin.scheduling.GoogleCalendarAutoSyncCard
import com.tribetails.auntieos.ui.admin.scheduling.GoogleCalendarConnection
import com.tribetails.auntieos.ui.admin.scheduling.GoogleCalendarUiState
import com.tribetails.auntieos.ui.admin.scheduling.ScheduleWriteBanner
import com.tribetails.auntieos.ui.admin.scheduling.calendarIdProblem
import com.tribetails.auntieos.ui.admin.scheduling.calendarSyncRunLabel
import com.tribetails.auntieos.ui.admin.scheduling.googleCalendarPushLabel
import com.tribetails.auntieos.ui.admin.scheduling.writeCalendarProblem
import com.tribetails.auntieos.ui.admin.services.ServiceManagementViewModel
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.theme.AuntieTheme

import java.time.LocalDate
import androidx.compose.ui.unit.dp

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
                        lastRun = schedulingState.calendarSyncRun,
                        onSaveCalendarSyncId = { schedulingViewModel.saveCalendarSyncId(it) },
                        onRunSync = { schedulingViewModel.importGoogleBusyEvents() },
                        onDismissError = { schedulingViewModel.clearCalendarSyncFeedback() },
                    )
                }
            }

            item {
                AuntieCard {
                    GoogleCalendarConnectCard(
                        state = schedulingState.googleCalendar,
                        onConnect = { schedulingViewModel.connectGoogleCalendar() },
                        onConsumeAuthUrl = { schedulingViewModel.consumeGoogleCalendarAuthUrl() },
                        onRefreshCalendars = { schedulingViewModel.refreshGoogleCalendars() },
                        onSaveTargets = { writeId, enabledIds -> schedulingViewModel.saveGoogleCalendarTargets(writeId, enabledIds) },
                        onPush = { schedulingViewModel.pushGoogleCalendarVisits() },
                        onDisconnect = { schedulingViewModel.disconnectGoogleCalendar() },
                        onDismissError = { schedulingViewModel.clearGoogleCalendarError() },
                    )
                }
            }

            // Issue #397. Its own card in its own file, so the automatic sync's
            // receipt and its retry do not thread through the already large
            // connect card above.
            item {
                AuntieCard {
                    GoogleCalendarAutoSyncCard(
                        state = schedulingState.googleCalendar,
                        onRetryVisit = { schedulingViewModel.retryGoogleCalendarVisitSync(it) },
                        onDismissNote = { schedulingViewModel.clearGoogleCalendarVisitSyncNote() },
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
                        // The mode buttons used to be three identical GhostButtons
                        // with no selected state at all, so the operator could not
                        // see which one the Save would use. A SegmentedPicker is
                        // the component that shows a choice.
                        SegmentedPicker(
                            options = BlockMode.entries.toList(),
                            selected = blockMode,
                            onSelect = { blockMode = it },
                            label = { it.label },
                        )
                        AuntieField(
                            value = selectedDate,
                            onValueChange = { selectedDate = it },
                            label = "Date (YYYY-MM-DD)",
                            modifier = Modifier.fillMaxWidth()
                        )
                        // Hidden in Whole day, rather than shown and ignored: the
                        // window is 00:00-23:59 in that mode and a field whose
                        // value is discarded is a control that lies.
                        if (blockMode == BlockMode.TIME_BLOCK) {
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
                        }
                        AuntieField(
                            value = blockReason,
                            onValueChange = { blockReason = it },
                            label = "Reason",
                            modifier = Modifier.fillMaxWidth()
                        )
                        PrimaryButton(
                            label = if (schedulingState.scheduleWriteInFlight) "Blocking…" else "Save Block",
                            enabled = !schedulingState.scheduleWriteInFlight,
                            onClick = {
                                // Everything this used to do inline -- and get
                                // wrong, silently falling back to today on an
                                // unparseable date -- now lives in
                                // `resolveBlockWindow`, behind the ViewModel.
                                schedulingViewModel.blockTimeSlot(
                                    dateText = selectedDate,
                                    startTime = startTime,
                                    endTime = endTime,
                                    reason = blockReason,
                                    mode = blockMode,
                                )
                            },
                            modifier = Modifier.fillMaxWidth()
                        )
                        ScheduleWriteBanner(
                            message = schedulingState.scheduleWriteError,
                            override = schedulingState.scheduleWriteOverride,
                            busy = schedulingState.scheduleWriteInFlight,
                            title = "Couldn’t block the time",
                            overrideLabel = "Block anyway",
                            onOverride = { schedulingViewModel.retryScheduleWriteWithOverride() },
                            onDismiss = { schedulingViewModel.clearScheduleWriteFeedback() },
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

/**
 * #574: UNBLOCK IS DRAWN ONLY ON THE OPERATOR'S OWN BLOCKS.
 *
 * This list mixes two writers. A `GOOGLE_BUSY_IMPORT` row is a mirror of an
 * event on the connected Google Calendar, and deleting it here would not free
 * the time — the next sync reads the same event and writes the row straight
 * back. `deleteBlockedTimeSlot` refuses those server-side; drawing the button
 * anyway would make the refusal the operator's first news of it, which is the
 * dead control this codebase's Buttons convention exists to prevent. The row
 * says where the block came from instead.
 */
@Composable
private fun BlockedEntriesList(entries: List<BookingTimeSlot>, onUnblock: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        entries.take(20).forEach { slot ->
            val imported = slot.source == TimeSlotSource.GOOGLE_BUSY_IMPORT
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("${slot.date} ${slot.startTime}-${slot.endTime} (${slot.notes})", style = AuntieTheme.typography.bodySmall)
                Text(
                    text = if (imported) "Google Busy" else "Manual",
                    style = AuntieTheme.typography.labelSmall,
                    color = AuntieTheme.colors.kinfolkOrange
                )
                if (imported) {
                    Text(
                        text = "Clear it in Google Calendar",
                        style = AuntieTheme.typography.labelSmall,
                        color = AuntieTheme.colors.textPrimary,
                    )
                } else {
                    GhostButton(label = "Unblock", onClick = { onUnblock(slot.id) })
                }
            }
        }
    }
}

/**
 * Slice 8: the Google Calendar Sync card body. Extracted as a stateless,
 * parameter-driven composable so its states (dark/not-enabled, idle Run Sync,
 * syncing spinner, error banner with the server message, the last-run receipt)
 * are unit-testable under Robolectric without standing up the full screen + VMs.
 *
 * TWO STEPS, NOT ONE (2026-07-25, parity with the React admin's
 * `CalendarSyncSection.tsx`). The callable takes no calendar id: it resolves the
 * SAVED `business_settings.calendarSyncId` server-side, so Run Sync acts on what
 * was saved, not on what is in the text box. The button therefore stays disabled
 * while the field is edited, and while the saved id cannot work at all, and says
 * which it is. A Run Sync that quietly used the old id after an edit is exactly
 * the "did that even work?" confusion this card exists to end.
 */
@Composable
internal fun GoogleCalendarSyncCard(
    syncEnabled: Boolean,
    isSyncing: Boolean,
    errorMessage: String?,
    successMessage: String?,
    calendarSyncId: String,
    calendarSyncIdSaved: Boolean,
    lastRun: CalendarSyncRun?,
    onSaveCalendarSyncId: (String) -> Unit,
    onRunSync: () -> Unit,
    onDismissError: () -> Unit,
) {
    // Hoisted out of CalendarSyncIdField so the Run Sync gate below can see an
    // unsaved edit. Re-seeds when the persisted value changes.
    var draft by remember(calendarSyncId) { mutableStateOf(calendarSyncId) }
    val draftProblem = if (draft.isBlank()) null else calendarIdProblem(draft)
    val savedProblem = calendarIdProblem(calendarSyncId)
    val dirty = draft.trim() != calendarSyncId.trim()

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
        // (saved to business_settings.calendarSyncId), which is the ONLY source the
        // server reads. Auth stays a service account the admin shares the calendar
        // with (no OAuth entry).
        CalendarSyncIdField(
            draft = draft,
            onDraftChange = { draft = it },
            draftProblem = draftProblem,
            calendarSyncIdSaved = calendarSyncIdSaved,
            isSaving = isSyncing,
            onSave = onSaveCalendarSyncId,
        )

        if (!syncEnabled) {
            // Server callable not enabled yet (operator must set GOOGLE_CALENDAR_ID
            // and share the calendar). Ship dark with a visible banner, never a
            // silent no-op button. (This screen's sole caller always passes
            // syncEnabled = true today, so this branch is currently unreachable.)
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

            // What the LAST run actually did, from the server's own stamp. It
            // outlives this screen, so a sync that failed days ago still says so
            // instead of looking like a sync that was never attempted.
            Text(
                calendarSyncRunLabel(lastRun) ?: "This calendar has never been synced.",
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim
            )

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
            } else if (dirty) {
                Text(
                    "Save the calendar ID first. The sync runs on the server and reads the saved value, not what is in the box.",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim
                )
            } else if (savedProblem != null) {
                Text(
                    // The full explanation only when the field above is not
                    // already showing it. Printing the same three lines twice
                    // makes the shorter one look like a second, different fault.
                    if (draftProblem == null) "Nothing to sync yet. $savedProblem"
                    else "Nothing to sync yet. Fix the calendar ID above.",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim
                )
            } else {
                GhostButton(label = "Run Sync", onClick = onRunSync)
            }
        }
    }
}

/**
 * Front-facing Google Calendar ID setup field. The admin types the shared
 * calendar id here and Saves; it persists to business_settings.calendarSyncId
 * (round-trips via AuntieRepository) and the server-side sync reads that saved
 * value. The hint names the exact service account the admin must share the
 * calendar with. Auth stays a service account, no OAuth/token entry.
 *
 * Fully stateless as of 2026-07-25: the draft lives in the parent card, which
 * needs it to gate Run Sync on an unsaved edit. The shape check runs before
 * Save, so an id that could only ever import nothing is refused here rather than
 * saved and then reported by the server as an empty calendar.
 */
@Composable
internal fun CalendarSyncIdField(
    draft: String,
    onDraftChange: (String) -> Unit,
    draftProblem: String?,
    calendarSyncIdSaved: Boolean,
    isSaving: Boolean,
    onSave: (String) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        AuntieField(
            value = draft,
            onValueChange = onDraftChange,
            label = "Google Calendar ID",
            placeholder = CALENDAR_ID_EXAMPLE,
            enabled = !isSaving,
            modifier = Modifier.fillMaxWidth()
        )
        Text(
            "Share this calendar with $CALENDAR_SYNC_SA_EMAIL at See only free/busy (hide details), then save the calendar id here.",
            style = AuntieTheme.typography.bodySmall,
            color = AuntieTheme.colors.textDim
        )
        if (draftProblem != null) {
            Text(
                draftProblem,
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.error
            )
        }
        PrimaryButton(
            label = "Save Calendar ID",
            onClick = { onSave(draft) },
            enabled = !isSaving && draftProblem == null,
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

/**
 * Task 7.2: Google Calendar over OAuth, the editable half. A DIFFERENT FEATURE
 * from [GoogleCalendarSyncCard] above, sharing nothing but the word calendar:
 * that card reads free/busy off a shared calendar as a service account; this
 * one writes visits onto a calendar belonging to a Google account the operator
 * signs into. See `GoogleCalendarTargets.kt` and `CALLABLE_CONTRACT.md`.
 *
 * Extracted stateless, same posture as [GoogleCalendarSyncCard], so every
 * state (not connected with setup copy, connecting, polling with a visible
 * timeout, connected with a calendar picker, a failed push, a failed
 * disconnect) is unit-testable under Robolectric without standing up the VM.
 */
@Composable
internal fun GoogleCalendarConnectCard(
    state: GoogleCalendarUiState,
    onConnect: () -> Unit,
    onConsumeAuthUrl: () -> Unit,
    onRefreshCalendars: () -> Unit,
    onSaveTargets: (writeCalendarId: String, enabledCalendarIds: List<String>) -> Unit,
    onPush: () -> Unit,
    onDisconnect: () -> Unit,
    onDismissError: () -> Unit,
) {
    val context = LocalContext.current

    // Opens the consent URL in a Custom Tab exactly once per mint (androidx.browser
    // is already a dependency; CallsScreen/InboxScreen use the same launcher). The
    // ViewModel clears pendingAuthUrl the instant this fires, so a later
    // recomposition (rotation, another state update while the tab is open) can
    // never relaunch the same one-time URL a second time.
    LaunchedEffect(state.pendingAuthUrl) {
        val url = state.pendingAuthUrl
        if (url != null) {
            runCatching { CustomTabsIntent.Builder().build().launchUrl(context, Uri.parse(url)) }
            onConsumeAuthUrl()
        }
    }

    val connection = state.connection
    val connected = connection?.connected == true

    Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Lucide.CalendarCheck, contentDescription = null, tint = AuntieTheme.colors.kinfolkOrange)
            Text("Google Calendar (editable)", style = AuntieTheme.typography.titleMedium)
        }
        Text(
            "Connect a Google account so AuntieOS can write upcoming visits directly onto its calendar. " +
                "This is separate from the Google Calendar Sync above, which only reads availability.",
            style = AuntieTheme.typography.bodySmall,
            color = AuntieTheme.colors.textPrimary,
        )

        state.error?.let { msg ->
            AuntieBanner(tone = AuntieBannerTone.Error, title = "Google Calendar", onDismiss = onDismissError) {
                Text(msg, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
            }
        }

        when {
            state.polling -> {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    AuntieSpinner(modifier = Modifier.size(16.dp), strokeWidth = 2.dp, color = AuntieTheme.colors.kinfolkOrange)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "Waiting for you to finish in the browser...",
                        color = AuntieTheme.colors.kinfolkOrange,
                        style = AuntieTheme.typography.bodySmall,
                    )
                }
            }
            connected -> {
                ConnectedGoogleCalendarBody(
                    state = state,
                    connection = connection!!,
                    onRefreshCalendars = onRefreshCalendars,
                    onSaveTargets = onSaveTargets,
                    onPush = onPush,
                    onDisconnect = onDisconnect,
                )
            }
            else -> {
                NotConnectedGoogleCalendarBody(state = state, onConnect = onConnect)
            }
        }
    }
}

@Composable
private fun NotConnectedGoogleCalendarBody(
    state: GoogleCalendarUiState,
    onConnect: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (state.pollTimedOut) {
            // The poll window ended with nothing connected. This is NOT the same
            // as an error the callback reported (that renders as state.error
            // above); this is Google never having called back inside the window
            // at all, and the card must not pretend it knows why.
            Text(
                "Nothing connected within the two-minute window. If you finished the Google screen, " +
                    "try Connect again; the connection will show here once Google confirms it.",
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim,
            )
        }
        Text(
            "Setup, once, by an operator with access to Google Cloud Console and the Firebase CLI: " +
                "create an OAuth client ID of type Web application with redirect URI " +
                "${state.redirectUri}, then set the secrets " +
                "${GOOGLE_OAUTH_SECRET_NAMES.joinToString(" and ")} and redeploy.",
            style = AuntieTheme.typography.bodySmall,
            color = AuntieTheme.colors.textDim,
        )
        PrimaryButton(
            label = "Connect Google Calendar",
            onClick = onConnect,
            enabled = !state.connecting,
            loading = state.connecting,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun ConnectedGoogleCalendarBody(
    state: GoogleCalendarUiState,
    connection: GoogleCalendarConnection,
    onRefreshCalendars: () -> Unit,
    onSaveTargets: (String, List<String>) -> Unit,
    onPush: () -> Unit,
    onDisconnect: () -> Unit,
) {
    // Draft re-seeds whenever the SAVED write target changes, same pattern as
    // CalendarSyncIdField's draft: what Save acts on is what is ticked here,
    // not silently the last-saved value.
    var selectedWriteId by remember(connection.writeCalendarId) { mutableStateOf(connection.writeCalendarId) }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            "Connected as ${connection.googleAccountEmail}",
            style = AuntieTheme.typography.bodyMedium,
            color = AuntieTheme.colors.textPrimary,
        )

        if (state.calendars.isEmpty()) {
            GhostButton(label = "Load calendars", onClick = onRefreshCalendars)
        } else {
            Text(
                "Pick the calendar visits are pushed to:",
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim,
            )
            state.calendars.forEach { cal: GoogleCalendarSummary ->
                // Read-only calendars are SHOWN, not filtered out, and marked
                // rather than hidden: a calendar missing from this list must
                // always mean "the connection is broken", never "it was there
                // but could not be picked". Same reasoning as the server's
                // toCalendarSummaries in googleCalendarSelection.ts.
                val writable = cal.accessRole == "owner" || cal.accessRole == "writer"
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    AuntieCheckbox(
                        checked = selectedWriteId.trim().equals(cal.id.trim(), ignoreCase = true) ||
                            (selectedWriteId.trim().equals("primary", ignoreCase = true) && cal.primary),
                        onCheckedChange = { checked -> if (writable && checked) selectedWriteId = cal.id },
                        enabled = writable,
                    )
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            cal.summary,
                            style = AuntieTheme.typography.bodySmall,
                            color = if (writable) AuntieTheme.colors.textPrimary else AuntieTheme.colors.textFaint,
                        )
                        if (!writable) {
                            Text(
                                "Read-only on this account (${cal.accessRole.ifBlank { "unknown" }}), cannot receive visits.",
                                style = AuntieTheme.typography.labelSmall,
                                color = AuntieTheme.colors.textFaint,
                            )
                        }
                    }
                }
            }

            val problem = writeCalendarProblem(selectedWriteId, state.freeBusyCalendarId, connection.googleAccountEmail)
            problem?.let {
                Text(it, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.error)
            }
            PrimaryButton(
                label = "Save calendar",
                onClick = { onSaveTargets(selectedWriteId, listOf(selectedWriteId)) },
                enabled = !state.savingTargets && problem == null,
                loading = state.savingTargets,
                modifier = Modifier.fillMaxWidth(),
            )
        }

        // The last-push receipt, from the server's own stamp: it outlives this
        // screen, so a push that failed yesterday still says so rather than
        // looking like a push that was never attempted. A push of zero reads as
        // "nothing needed pushing", a different fact from having never pushed.
        Text(
            googleCalendarPushLabel(connection) ?: "Visits have never been pushed to this calendar.",
            style = AuntieTheme.typography.bodySmall,
            color = AuntieTheme.colors.textDim,
        )
        if (state.pushSkipped.isNotEmpty()) {
            Text(
                // A real count rather than "visit(s)", and the server's own
                // reason: a visit with no end time and no duration is skipped
                // rather than given an invented length, because an event
                // claiming a duration nobody entered blocks out time the
                // operator never agreed to.
                if (state.pushSkipped.size == 1) {
                    "1 visit was skipped on the last push. It has no end time and no duration, " +
                        "so there is no length to put on the calendar."
                } else {
                    "${state.pushSkipped.size} visits were skipped on the last push. They have " +
                        "no end time and no duration, so there is no length to put on the calendar."
                },
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.warning,
            )
        }
        GhostButton(
            label = if (state.pushing) "Pushing..." else "Push visits to Google",
            onClick = onPush,
            enabled = !state.pushing && connection.writeCalendarId.isNotBlank(),
        )

        Text(
            "Disconnecting stops future pushes. Visits already written to Google are NOT removed: " +
                "AuntieOS holds no credential to delete them, and one may still be live inside an " +
                "already-sent email.",
            style = AuntieTheme.typography.bodySmall,
            color = AuntieTheme.colors.textDim,
        )
        if (connection.disconnectedError.isNotBlank()) {
            Text(
                connection.disconnectedError,
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.error,
            )
        }
        GhostButton(
            label = if (state.disconnecting) "Disconnecting..." else "Disconnect",
            onClick = onDisconnect,
            enabled = !state.disconnecting,
        )
    }
}
