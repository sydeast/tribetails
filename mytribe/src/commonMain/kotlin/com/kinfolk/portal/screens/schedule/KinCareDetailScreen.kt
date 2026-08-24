package com.kinfolk.portal.screens.schedule

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinField
import com.kinfolk.portal.components.KinGhostButton
import com.kinfolk.portal.portal.Booking
import com.kinfolk.portal.portal.CancelRequestStatus
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.RescheduleRequestStatus
import com.kinfolk.portal.portal.canRequestCancellation
import com.kinfolk.portal.portal.canRequestReschedule
import com.kinfolk.portal.portal.isAwaitingVisit
import com.kinfolk.portal.screens.schedule.util.RESCHEDULE_REASON_MAX
import com.kinfolk.portal.screens.schedule.util.ReviewRow
import com.kinfolk.portal.screens.schedule.util.proposedStartMillis
import com.kinfolk.portal.screens.schedule.util.rescheduleProblem
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import com.kinfolk.portal.util.relativeTime
import com.kinfolk.portal.util.weekdayTime
import kotlinx.coroutines.launch
import kotlinx.datetime.LocalDate
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlin.time.Clock
import kotlin.time.Instant

private const val NOTE_CUTOFF_MS: Long = 3L * 60L * 60L * 1000L
private const val CANCEL_REASON_MAX = 500

/**
 * Detail view for one KinCare (a single visit/session). Resolves the KinCare
 * from getMyBookings by id and lets the kinfolk append a note until 3hr before
 * the visit starts. Note saves target the parent envelope via
 * addBookingNote(batchId, visitId, body).
 */
@Composable
fun KinCareDetailScreen(
    kinCareId: String,
    kinfolkId: String,
    portalApi: PortalApi,
    onBack: () -> Unit,
    nowMs: () -> Long = { Clock.System.now().toEpochMilliseconds() },
) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()
    var kinCare by remember { mutableStateOf<Booking?>(null) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var noteInput by remember { mutableStateOf("") }
    var saveError by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    // Cancellation ask: local pending covers the gap between a successful call
    // and the next reload; the DTO flag takes over from there.
    var cancelPendingLocal by remember { mutableStateOf(false) }
    var cancelSending by remember { mutableStateOf(false) }
    var cancelError by remember { mutableStateOf<String?>(null) }
    // Reschedule ask: same two-part state as the cancellation above. The local
    // flag covers the gap between a successful call and the next reload; the
    // DTO's rescheduleRequestStatus takes over from there.
    var reschedulePendingLocal by remember { mutableStateOf(false) }
    var rescheduleSending by remember { mutableStateOf(false) }
    var rescheduleError by remember { mutableStateOf<String?>(null) }

    suspend fun reload() {
        try {
            val all = portalApi.getMyBookings(kinfolkId)
            val fromEnvelopes = all.envelopes.flatMap { it.kinCares }
            kinCare = (all.upcoming + all.recent + fromEnvelopes).firstOrNull { it.id == kinCareId }
                ?: all.liveVisit?.takeIf { it.id == kinCareId }
            loadError = if (kinCare == null) "Booking not found." else null
        } catch (t: Throwable) {
            loadError = t.message ?: "Could not load booking."
        }
    }

    LaunchedEffect(kinCareId, kinfolkId) { reload() }

    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        // Header w/ back button
        Row(
            modifier = Modifier.fillMaxWidth().padding(KinfolkSpacing.s),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back", tint = KinfolkBrand.Navy)
            }
            Spacer(Modifier.width(KinfolkSpacing.xs))
            Text("Visit Details", style = type.heritageTitle)
        }

        val b = kinCare
        when {
            loadError != null -> {
                Text(
                    loadError ?: "",
                    style = type.sansBody,
                    color = KinfolkBrand.SnuggleCoral,
                    modifier = Modifier.padding(KinfolkSpacing.l),
                )
            }
            b == null -> {
                Box(
                    modifier = Modifier.fillMaxWidth().padding(KinfolkSpacing.l),
                    contentAlignment = Alignment.Center,
                ) {
                    CircularProgressIndicator(color = KinfolkBrand.KinfolkOrange)
                }
            }
            else -> {
                KinCareDetailBody(
                    kinCare = b,
                    noteInput = noteInput,
                    onNoteInputChange = { noteInput = it },
                    saving = saving,
                    saveError = saveError,
                    nowMs = nowMs(),
                    onSaveNote = {
                        val body = noteInput.trim()
                        if (body.isBlank()) {
                            saveError = "Note cannot be empty."
                            return@KinCareDetailBody
                        }
                        scope.launch {
                            saving = true
                            saveError = null
                            try {
                                portalApi.addBookingNote(
                                    batchId = b.batchId ?: b.id,
                                    visitId = b.id,
                                    body = body,
                                    kinfolkId = kinfolkId,
                                )
                                noteInput = ""
                                reload()
                            } catch (t: Throwable) {
                                saveError = t.message ?: "Could not save note."
                            } finally {
                                saving = false
                            }
                        }
                    },
                    reschedulePendingLocal = reschedulePendingLocal,
                    rescheduleSending = rescheduleSending,
                    rescheduleError = rescheduleError,
                    onSendRescheduleRequest = { proposedStartMs, reason ->
                        val batchId = b.batchId
                        if (batchId == null) {
                            // canRequestReschedule() keeps the control off the
                            // screen without one, so this is belt and braces.
                            rescheduleError = "This visit isn't linked to a booking yet."
                            return@KinCareDetailBody
                        }
                        scope.launch {
                            rescheduleSending = true
                            rescheduleError = null
                            try {
                                portalApi.requestBookingReschedule(
                                    batchId = batchId,
                                    visitId = b.id,
                                    proposedStartTimeMs = proposedStartMs,
                                    reason = reason,
                                    kinfolkId = kinfolkId,
                                )
                                reschedulePendingLocal = true
                                reload()
                            } catch (t: Throwable) {
                                // The server writes these for a household to
                                // read (a past time, a second ask while one is
                                // pending), so they are shown as they arrive
                                // rather than flattened to "try again".
                                rescheduleError = t.message ?: "Could not send the request."
                            } finally {
                                rescheduleSending = false
                            }
                        }
                    },
                    cancelPending = b.cancelRequested || cancelPendingLocal,
                    cancelSending = cancelSending,
                    cancelError = cancelError,
                    onSendCancelRequest = { reason ->
                        scope.launch {
                            cancelSending = true
                            cancelError = null
                            try {
                                // alreadyPending=true is still success: the ask
                                // is on file either way, so render pending.
                                portalApi.requestBookingCancellation(
                                    batchId = b.batchId ?: b.id,
                                    visitId = b.id,
                                    reason = reason,
                                    kinfolkId = kinfolkId,
                                )
                                cancelPendingLocal = true
                                reload()
                            } catch (t: Throwable) {
                                cancelError = t.message ?: "Could not send the request."
                            } finally {
                                cancelSending = false
                            }
                        }
                    },
                )
            }
        }
        Spacer(Modifier.height(KinfolkSpacing.l))
    }
}

@Composable
private fun KinCareDetailBody(
    kinCare: Booking,
    noteInput: String,
    onNoteInputChange: (String) -> Unit,
    saving: Boolean,
    saveError: String?,
    nowMs: Long,
    onSaveNote: () -> Unit,
    reschedulePendingLocal: Boolean,
    rescheduleSending: Boolean,
    rescheduleError: String?,
    onSendRescheduleRequest: (proposedStartMs: Long, reason: String?) -> Unit,
    cancelPending: Boolean,
    cancelSending: Boolean,
    cancelError: String?,
    onSendCancelRequest: (reason: String?) -> Unit,
) {
    val type = LocalKinfolkTypography.current
    val start = kinCare.startTimeMs
    val locked = start != null && nowMs >= (start - NOTE_CUTOFF_MS)

    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
    ) {
        // Service + time
        GlassCard(
            modifier = Modifier.fillMaxWidth(),
            contentPadding = PaddingValues(KinfolkSpacing.l),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                Text(kinCare.title ?: kinCare.serviceType ?: "Booking", style = type.heritageTitle)
                Text(start?.let { relativeTime(it) } ?: "TBD", style = type.sansLabel)
                ReviewRow("KinCare Duration", kinCare.serviceType ?: "TBD")
                ReviewRow("Auntie", kinCare.auntieDisplayName ?: "Pending")
                ReviewRow(
                    "Kin",
                    kinCare.kinNames.takeIf { it.isNotEmpty() }?.joinToString(", ") ?: "TBD",
                )
                ReviewRow("Status", statusLabel(kinCare))
            }
        }

        // Existing kinfolk-facing note (from wizard submission OR previously appended)
        if (!kinCare.notes.isNullOrBlank()) {
            GlassCard(
                modifier = Modifier.fillMaxWidth(),
                contentPadding = PaddingValues(KinfolkSpacing.l),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
                    Text("On File", style = type.sansLabel)
                    Text(kinCare.notes!!, style = type.sansBody)
                }
            }
        }

        // Editable Additional Information
        GlassCard(
            modifier = Modifier.fillMaxWidth(),
            contentPadding = PaddingValues(KinfolkSpacing.l),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                Text("Additional Information", style = type.heritageSection)
                Text(
                    "Anything Auntie should know? Editable until 3 hours before the visit starts.",
                    style = type.sansMeta,
                )
                KinField(
                    value = noteInput,
                    onValueChange = onNoteInputChange,
                    label = "e.g., gate code changed to 1248; please use side door",
                    singleLine = false,
                    enabled = !locked,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (locked) {
                    Text(
                        "Notes locked (visit starts in under 3hr).",
                        style = type.sansMeta,
                        color = KinfolkBrand.SnuggleCoral,
                    )
                }
                if (saveError != null) {
                    Text(saveError, style = type.sansMeta, color = KinfolkBrand.SnuggleCoral)
                }
                KinButton(
                    label = if (saving) "Saving..." else "Save Note",
                    onClick = onSaveNote,
                    enabled = !locked && !saving && noteInput.isNotBlank(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }

        // Reschedule ask. The card also carries the office's answer, so an
        // accepted or declined ask stays readable after the window to make a
        // new one has closed.
        if (kinCare.rescheduleRequestStatus != null || kinCare.canRequestReschedule()) {
            RescheduleRequestSection(
                kinCare = kinCare,
                pendingLocal = reschedulePendingLocal,
                sending = rescheduleSending,
                error = rescheduleError,
                nowMs = nowMs,
                onSend = onSendRescheduleRequest,
            )
        }

        // Cancellation ask. Shown while the visit is still ahead, and ALSO
        // whenever the office has already answered one, so an accepted or
        // declined ask stays readable after the window to make a new one has
        // closed. Same rule the reschedule card above follows.
        if (kinCare.isAwaitingVisit() || kinCare.cancelRequestStatus != null) {
            CancelRequestSection(
                kinCare = kinCare,
                pending = cancelPending,
                canAsk = kinCare.canRequestCancellation(),
                sending = cancelSending,
                error = cancelError,
                onSend = onSendCancelRequest,
            )
        }
    }
}

/**
 * "Need a different time?" card (#469; the web portal's BookingDetail carries
 * the same four states).
 *
 * A household PROPOSES here, it never moves the visit. The visit keeps its
 * time and its status until Tribe Tails rules on the ask, which is why the
 * copy says request throughout and why the answer, when it comes, is shown
 * with the time that was asked for beside it.
 *
 * The four states: an ask waiting on the office, an accepted one, a declined
 * one with the office's note, and the form for making one.
 */
@Composable
private fun RescheduleRequestSection(
    kinCare: Booking,
    pendingLocal: Boolean,
    sending: Boolean,
    error: String?,
    nowMs: Long,
    onSend: (proposedStartMs: Long, reason: String?) -> Unit,
) {
    val type = LocalKinfolkTypography.current
    val status = kinCare.rescheduleRequestStatus
    val pending = pendingLocal || status == RescheduleRequestStatus.Pending
    val proposedLabel = weekdayTime(kinCare.rescheduleRequestedStartTimeMs)
    val responseNote = kinCare.rescheduleResponseNote?.takeIf { it.isNotBlank() }

    GlassCard(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            Text("Need a different time?", style = type.heritageSection)
            when {
                pending -> Text(
                    if (proposedLabel.isNotEmpty()) {
                        "New time requested for $proposedLabel. We'll confirm shortly."
                    } else {
                        "New time requested. We'll confirm shortly."
                    },
                    style = type.sansMeta,
                    color = KinfolkBrand.NavyMuted,
                )
                status == RescheduleRequestStatus.Accepted -> Text(
                    listOfNotNull(
                        "Your new time was accepted. This visit now shows the time you asked for.",
                        responseNote,
                    ).joinToString(" "),
                    style = type.sansMeta,
                    color = KinfolkBrand.KinTeal,
                )
                status == RescheduleRequestStatus.Declined -> Text(
                    listOfNotNull(
                        "Tribe Tails could not take ${proposedLabel.ifEmpty { "that time" }}.",
                        responseNote,
                    ).joinToString(" "),
                    style = type.sansMeta,
                    color = KinfolkBrand.SnuggleCoral,
                )
            }

            if (kinCare.canRequestReschedule() && !pending) {
                RescheduleProposalForm(
                    sending = sending,
                    error = error,
                    nowMs = nowMs,
                    onSend = onSend,
                )
            }
        }
    }
}

/**
 * The proposal itself: a day off the next four weeks, a time, and an optional
 * reason. Folded behind "Reschedule visit" so the card reads as a caption
 * until a household actually wants one, the same way the cancellation ask
 * below reveals its confirm.
 *
 * The date grid starts TODAY rather than at the first of the month: every day
 * already behind us is a time the server refuses, so offering them would be
 * offering a refusal.
 */
@Composable
private fun RescheduleProposalForm(
    sending: Boolean,
    error: String?,
    nowMs: Long,
    onSend: (proposedStartMs: Long, reason: String?) -> Unit,
) {
    val type = LocalKinfolkTypography.current
    var showForm by remember { mutableStateOf(false) }
    var pickedDate by remember { mutableStateOf<LocalDate?>(null) }
    var timeText by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf("") }
    var localProblem by remember { mutableStateOf<String?>(null) }

    if (!showForm) {
        KinGhostButton(
            label = "Reschedule visit",
            onClick = { showForm = true },
            modifier = Modifier.fillMaxWidth(),
        )
        return
    }

    Text(
        "This proposes a new time to Tribe Tails. The visit stays where it is until they accept.",
        style = type.sansMeta,
    )
    Text("New date", style = type.sansLabel)
    UpcomingDayPicker(
        nowMs = nowMs,
        selected = pickedDate,
        onSelect = { pickedDate = if (pickedDate == it) null else it },
    )
    KinField(
        value = timeText,
        onValueChange = { timeText = it },
        label = "Time (HH:MM)",
        enabled = !sending,
        modifier = Modifier.fillMaxWidth(),
        fieldTestTag = "rescheduleTime",
    )
    KinField(
        value = reason,
        onValueChange = { reason = it.take(RESCHEDULE_REASON_MAX) },
        label = "Why the change? (optional)",
        singleLine = false,
        enabled = !sending,
        modifier = Modifier.fillMaxWidth(),
        fieldTestTag = "rescheduleReason",
    )
    val problem = localProblem ?: error
    if (problem != null) {
        Text(problem, style = type.sansMeta, color = KinfolkBrand.SnuggleCoral)
    }
    KinButton(
        label = if (sending) "Sending..." else "Send this time to Tribe Tails",
        onClick = {
            val proposed = proposedStartMillis(pickedDate, timeText)
            val trouble = rescheduleProblem(proposed, nowMs)
            localProblem = trouble
            if (trouble == null && proposed != null) {
                onSend(proposed, reason.trim().takeIf { it.isNotEmpty() })
            }
        },
        enabled = !sending,
        modifier = Modifier.fillMaxWidth(),
    )
    KinGhostButton(
        label = "Never mind",
        onClick = {
            showForm = false
            localProblem = null
        },
        enabled = !sending,
        modifier = Modifier.fillMaxWidth(),
    )
}

/** Four weeks of days from today, seven to a row; tap one to pick it. */
@Composable
private fun UpcomingDayPicker(
    nowMs: Long,
    selected: LocalDate?,
    onSelect: (LocalDate) -> Unit,
) {
    val type = LocalKinfolkTypography.current
    val days = remember(nowMs) {
        val today = Instant.fromEpochMilliseconds(nowMs)
            .toLocalDateTime(TimeZone.currentSystemDefault())
            .date
        (0 until 28L).map { LocalDate.fromEpochDays(today.toEpochDays() + it) }
    }
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        days.chunked(7).forEach { week ->
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceEvenly) {
                week.forEach { d ->
                    val isSelected = selected == d
                    Box(
                        modifier = Modifier
                            .size(38.dp)
                            .background(
                                color = if (isSelected) KinfolkBrand.KinTeal else KinfolkBrand.GlassSurfaceDim,
                                shape = CircleShape,
                            )
                            .clickable { onSelect(d) },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            d.day.toString(),
                            style = type.sansMeta.copy(
                                color = if (isSelected) Color.White else KinfolkBrand.Navy,
                            ),
                        )
                    }
                }
            }
        }
    }
}

/**
 * "Need to cancel?" card. Tap reveals an inline confirm with an optional
 * short reason; the ask does not change the visit status.
 *
 * The same four states the reschedule card above carries (#438): an ask
 * waiting on the office, an accepted one, a declined one with the office's
 * note, and the form for making one. Before #438 there were only two, because
 * nothing in the office ever answered: the ask was written to the visit and no
 * admin screen read it, so "we'll confirm soon" was a promise nobody could
 * keep. A declined ask reopens the form, because the household may have new
 * information and should not be stuck behind a caption.
 */
@Composable
private fun CancelRequestSection(
    kinCare: Booking,
    pending: Boolean,
    canAsk: Boolean,
    sending: Boolean,
    error: String?,
    onSend: (reason: String?) -> Unit,
) {
    val type = LocalKinfolkTypography.current
    val status = kinCare.cancelRequestStatus
    val responseNote = kinCare.cancelResponseNote?.takeIf { it.isNotBlank() }
    GlassCard(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            Text("Need to cancel?", style = type.heritageSection)
            when {
                pending -> Text(
                    "Cancellation requested. Tribe Tails has it in their queue and will answer soon.",
                    style = type.sansMeta,
                    color = KinfolkBrand.NavyMuted,
                )
                status == CancelRequestStatus.Accepted -> Text(
                    listOfNotNull("This visit is cancelled.", responseNote).joinToString(" "),
                    style = type.sansMeta,
                    color = KinfolkBrand.KinTeal,
                )
                status == CancelRequestStatus.Declined -> Text(
                    listOfNotNull(
                        "Tribe Tails is keeping this visit on the books.",
                        responseNote,
                    ).joinToString(" "),
                    style = type.sansMeta,
                    color = KinfolkBrand.SnuggleCoral,
                )
            }

            if (canAsk && !pending) {
                var showConfirm by remember { mutableStateOf(false) }
                var reason by remember { mutableStateOf("") }
                if (!showConfirm) {
                    KinGhostButton(
                        label = if (status == CancelRequestStatus.Declined) {
                            "Ask again"
                        } else {
                            "Request cancellation"
                        },
                        onClick = { showConfirm = true },
                        modifier = Modifier.fillMaxWidth(),
                    )
                } else {
                    Text(
                        "This goes to Tribe Tails' requests queue. The visit stays on the books until they accept it.",
                        style = type.sansMeta,
                    )
                    KinField(
                        value = reason,
                        onValueChange = { reason = it.take(CANCEL_REASON_MAX) },
                        label = "Reason (optional)",
                        singleLine = false,
                        enabled = !sending,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (error != null) {
                        Text(error, style = type.sansMeta, color = KinfolkBrand.SnuggleCoral)
                    }
                    KinButton(
                        label = if (sending) "Sending..." else "Send request",
                        onClick = { onSend(reason.trim().takeIf { it.isNotEmpty() }) },
                        enabled = !sending,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    KinGhostButton(
                        label = "Keep visit",
                        onClick = { showConfirm = false },
                        enabled = !sending,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}

private fun statusLabel(b: Booking): String = when (b.status) {
    com.kinfolk.portal.portal.BookingStatus.Requested -> "Requested"
    com.kinfolk.portal.portal.BookingStatus.Confirmed -> "Confirmed"
    com.kinfolk.portal.portal.BookingStatus.EnRoute -> "Auntie en route"
    com.kinfolk.portal.portal.BookingStatus.Active -> "In progress"
    com.kinfolk.portal.portal.BookingStatus.Completed -> "Completed"
    com.kinfolk.portal.portal.BookingStatus.Cancelled -> "Cancelled"
}
