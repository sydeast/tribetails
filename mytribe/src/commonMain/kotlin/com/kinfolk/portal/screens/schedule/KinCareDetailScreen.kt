package com.kinfolk.portal.screens.schedule

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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinChip
import com.kinfolk.portal.components.KinField
import com.kinfolk.portal.components.KinGhostButton
import com.kinfolk.portal.portal.Booking
import com.kinfolk.portal.portal.BookingMode
import com.kinfolk.portal.portal.BookingNotes
import com.kinfolk.portal.portal.BookingPolicy
import com.kinfolk.portal.portal.BusinessCalendar
import com.kinfolk.portal.portal.label
import com.kinfolk.portal.portal.CancelRequestStatus
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.RescheduleRequestStatus
import com.kinfolk.portal.portal.canRequestCancellation
import com.kinfolk.portal.portal.awaitingStartTime
import com.kinfolk.portal.portal.canRequestReschedule
import com.kinfolk.portal.portal.isAwaitingVisit
import com.kinfolk.portal.portal.isFinished
import com.kinfolk.portal.screens.schedule.util.RESCHEDULE_REASON_MAX
import com.kinfolk.portal.screens.schedule.util.ReviewRow
import com.kinfolk.portal.screens.schedule.util.RescheduleProposal
import com.kinfolk.portal.screens.schedule.util.blockChoices
import com.kinfolk.portal.screens.schedule.util.closedDaysFor
import com.kinfolk.portal.screens.schedule.util.FALLBACK_TIME_ZONE
import com.kinfolk.portal.screens.schedule.util.rescheduleModes
import com.kinfolk.portal.screens.schedule.util.resolveProposal
import com.kinfolk.portal.screens.schedule.util.rescheduleProblem
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import com.kinfolk.portal.util.bookingWhenLabel
import com.kinfolk.portal.util.noteWrittenAt
import com.kinfolk.portal.util.weekdayTime
import kotlin.coroutines.cancellation.CancellationException
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
    /**
     * #1303: a completed visit's KinTale lives on the KinTales tab. #1363: the
     * link hands over the tale's id, so the tab opens on that tale.
     */
    onOpenKinTale: (taleId: String) -> Unit = {},
    /** #1303: and its bill on the invoice screen. */
    onOpenInvoice: (invoiceId: String) -> Unit = {},
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

    // #1284: the reschedule form's two secondary reads. A failed read leaves the
    // wizard's own fallback (every day pickable, clock times) in place rather
    // than blocking the form; the server is the authority either way.
    var calendar by remember { mutableStateOf<BusinessCalendar?>(null) }
    var policy by remember { mutableStateOf<BookingPolicy?>(null) }
    // #1283: what this household already told its Auntie about the visit.
    var savedNotes by remember { mutableStateOf<BookingNotes?>(null) }
    var notesError by remember { mutableStateOf(false) }
    suspend fun reloadNotes(batchId: String?) {
        if (batchId == null) return
        try {
            savedNotes = portalApi.getBookingNotes(batchId = batchId, visitId = kinCareId, kinfolkId = kinfolkId)
            notesError = false
        } catch (c: CancellationException) {
            throw c
        } catch (_: Throwable) {
            notesError = true
        }
    }
    suspend fun reload() {
        try {
            val all = portalApi.getMyBookings(kinfolkId)
            val fromEnvelopes = all.envelopes.flatMap { it.kinCares }
            kinCare = (all.upcoming + all.recent + fromEnvelopes).firstOrNull { it.id == kinCareId }
                ?: all.liveVisit?.takeIf { it.id == kinCareId }
            loadError = if (kinCare == null) "Booking not found." else null
        } catch (c: CancellationException) {
            throw c
        } catch (t: Throwable) {
            loadError = t.message ?: "Could not load booking."
        }
    }

    LaunchedEffect(kinCareId, kinfolkId) {
        reload()
        reloadNotes(kinCare?.batchId)
        val today = Instant.fromEpochMilliseconds(nowMs()).toLocalDateTime(TimeZone.currentSystemDefault()).date
        try {
            calendar = portalApi.getBusinessCalendar(bookingDateKey(today), bookingDateKey(bookingHorizonEnd(today)))
        } catch (c: CancellationException) {
            throw c
        } catch (_: Throwable) {
            calendar = BusinessCalendar(closures = emptyList())
        }
        try {
            policy = portalApi.getBookingPolicy()
        } catch (c: CancellationException) {
            throw c
        } catch (_: Throwable) {
            policy = BookingPolicy.CLOCK_ONLY
        }
    }
    // #1303: the replay of a completed visit comes from the same getMyVisits row
    // the Schedule screen's Visit Replays reads (GPS lives on the AuntieOS
    // session, not the booking). Best effort: a failure only drops the replay.
    val replaySessionId = kinCare?.takeIf { it.status == com.kinfolk.portal.portal.BookingStatus.Completed }?.sessionId
    var replayVisit by remember { mutableStateOf<com.kinfolk.portal.portal.Visit?>(null) }
    var replayLoading by remember { mutableStateOf(false) }
    LaunchedEffect(replaySessionId, kinfolkId) {
        replayVisit = null
        if (replaySessionId == null) return@LaunchedEffect
        replayLoading = true
        try {
            replayVisit = portalApi.getMyVisits(kinfolkId, 20).visits.firstOrNull { it.id == replaySessionId }
        } catch (c: CancellationException) {
            throw c
        } catch (_: Throwable) {
            replayVisit = null
        } finally {
            replayLoading = false
        }
    }

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
                    replayVisit = replayVisit,
                    replayLoading = replayLoading,
                    onOpenKinTale = onOpenKinTale,
                    onOpenInvoice = onOpenInvoice,
                    kinCare = b,
                    noteInput = noteInput,
                    onNoteInputChange = { noteInput = it },
                    saving = saving,
                    saveError = saveError,
                    nowMs = nowMs(),
                    savedNotes = savedNotes,
                    notesError = notesError,
                    calendar = calendar,
                    policy = policy,
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
                                reloadNotes(b.batchId)
                            } catch (c: CancellationException) {
                                throw c
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
                    onSendRescheduleRequest = { proposal, reason ->
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
                                val res = portalApi.requestBookingReschedule(
                                    batchId = batchId,
                                    visitId = b.id,
                                    proposedStartTimeMs = proposal.startMs,
                                    reason = reason,
                                    kinfolkId = kinfolkId,
                                    timeBlockId = proposal.timeBlockId,
                                )
                                reschedulePendingLocal = true
                                // #1281: the server's own copy of the visit,
                                // shown at once. Without it, "Sending..." stays
                                // up through a fresh read instead.
                                val stored = res.visit
                                if (stored != null) kinCare = stored else reload()
                            } catch (c: CancellationException) {
                                throw c
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
                                val res = portalApi.requestBookingCancellation(
                                    batchId = b.batchId ?: b.id,
                                    visitId = b.id,
                                    reason = reason,
                                    kinfolkId = kinfolkId,
                                )
                                cancelPendingLocal = true
                                // #1281: same as the reschedule ask above.
                                val stored = res.visit
                                if (stored != null) kinCare = stored else reload()
                            } catch (c: CancellationException) {
                                throw c
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
    replayVisit: com.kinfolk.portal.portal.Visit?,
    replayLoading: Boolean,
    onOpenKinTale: (taleId: String) -> Unit,
    onOpenInvoice: (invoiceId: String) -> Unit,
    kinCare: Booking,
    noteInput: String,
    onNoteInputChange: (String) -> Unit,
    saving: Boolean,
    saveError: String?,
    nowMs: Long,
    savedNotes: BookingNotes?,
    notesError: Boolean,
    calendar: BusinessCalendar?,
    policy: BookingPolicy?,
    onSaveNote: () -> Unit,
    reschedulePendingLocal: Boolean,
    rescheduleSending: Boolean,
    rescheduleError: String?,
    onSendRescheduleRequest: (proposal: RescheduleProposal, reason: String?) -> Unit,
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
                Text(com.kinfolk.portal.util.visitTitle(kinCare.title, kinCare.serviceLabel) ?: "Booking", style = type.heritageTitle)
                Text(bookingWhenLabel(kinCare).ifEmpty { "TBD" }, style = type.sansLabel)
                ReviewRow("KinCare Duration", kinCare.serviceLabel ?: "TBD")
                ReviewRow("Auntie", kinCare.auntieDisplayName ?: "Pending")
                ReviewRow(
                    "Kin",
                    kinCare.kinNames.takeIf { it.isNotEmpty() }?.joinToString(", ") ?: "TBD",
                )
                ReviewRow("Status", statusLabel(kinCare))
                // #1303: where the visit happens, when the household has one on file.
                kinCare.address?.let { ReviewRow("Address", it) }
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

        // #1283: what the household already told its Auntie. The booking note
        // from the wizard and every note saved from this screen, each with the
        // time it was written. The server sends the household's own notes only.
        if (kinCare.batchId != null) {
            SavedNotesCard(savedNotes = savedNotes, error = notesError)
        }
        // #1285: a note is for the Auntie to read before the visit. Once the visit is
        // completed or cancelled there is nobody to read it, so the card is gone.
        if (!kinCare.isFinished()) {
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
        }

        // #1303: what a completed visit leaves behind: its KinTale, its bill and
        // its replay, each only when the record exists.
        if (kinCare.status == com.kinfolk.portal.portal.BookingStatus.Completed) {
            GlassCard(
                modifier = Modifier.fillMaxWidth(),
                contentPadding = PaddingValues(KinfolkSpacing.l),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                    Text("After the visit", style = type.heritageSection)
                    kinCare.kinTaleId?.let { taleId ->
                        KinGhostButton(label = "Read the KinTale", onClick = { onOpenKinTale(taleId) }, modifier = Modifier.fillMaxWidth())
                    }
                    kinCare.invoiceId?.let { invoiceId ->
                        KinGhostButton(label = "See the invoice", onClick = { onOpenInvoice(invoiceId) }, modifier = Modifier.fillMaxWidth())
                    }
                    when {
                        replayLoading -> com.kinfolk.portal.components.KinLoading(text = "Looking for the visit replay\u2026")
                        replayVisit != null && replayVisit.gpsRoute.isNotEmpty() -> {
                            Text("Visit Replay", style = type.sansLabel)
                            com.kinfolk.portal.components.RouteMap(
                                route = replayVisit.gpsRoute,
                                distanceMeters = replayVisit.gpsDistanceMeters,
                                durationSeconds = replayVisit.gpsDurationSeconds,
                            )
                        }
                        kinCare.kinTaleId == null && kinCare.invoiceId == null ->
                            Text("Nothing has been sent for this visit yet.", style = type.sansMeta)
                    }
                }
            }
        }
        // Reschedule ask. The card also carries the office's answer, so an
        // accepted or declined ask stays readable after the window to make a
        // new one has closed.
        // #1098: a night waiting on its start gets the card too, to say why it
        // cannot be moved yet.
        if (kinCare.rescheduleRequestStatus != null || kinCare.canRequestReschedule() || kinCare.awaitingStartTime()) {
            RescheduleRequestSection(
                kinCare = kinCare,
                // #1299: a cancellation ask in flight holds the new-time form,
                // including the moment before the refreshed visit arrives.
                heldByCancellation = cancelPending,
                pendingLocal = reschedulePendingLocal,
                sending = rescheduleSending,
                error = rescheduleError,
                nowMs = nowMs,
                calendar = calendar,
                policy = policy,
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
                // #1299: a new time waiting on the office holds the ask, on the
                // server and for the moment before the refreshed visit arrives.
                heldByReschedule = reschedulePendingLocal || kinCare.rescheduleRequestStatus == RescheduleRequestStatus.Pending,
                canAsk = kinCare.canRequestCancellation() && !reschedulePendingLocal,
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
    heldByCancellation: Boolean,
    pendingLocal: Boolean,
    sending: Boolean,
    error: String?,
    nowMs: Long,
    calendar: BusinessCalendar?,
    policy: BookingPolicy?,
    onSend: (proposal: RescheduleProposal, reason: String?) -> Unit,
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

            if (kinCare.awaitingStartTime() && !pending) {
                // #1098: the Auntie sets this night's start, and until she has
                // there is no time to move. Cancelling stays open below.
                Text(
                    "Your Auntie has not set the start time yet.",
                    style = type.sansMeta,
                    color = KinfolkBrand.NavyMuted,
                )
            }
            if (kinCare.canRequestReschedule() && !pending && !heldByCancellation) {
                RescheduleProposalForm(
                    serviceId = kinCare.serviceId,
                    sending = sending,
                    error = error,
                    nowMs = nowMs,
                    calendar = calendar,
                    policy = policy,
                    onSend = onSend,
                )
            }
        }
    }
}

/**
 * The proposal itself (#1284): the booking wizard's own month grid, with closed
 * company days and closed weekdays dimmed, then either the business's time
 * blocks or a clock time bounded by that weekday's hours, whichever the
 * business's policy offers for this visit. Then an optional reason. Folded
 * behind "Reschedule visit" so the card reads as a caption until a household
 * wants one, the same way the cancellation ask below reveals its confirm.
 *
 * It used to take any clock time on any of the next 28 days, so 2:00 AM went
 * through. The two reads behind it (closures with weekly hours, and the
 * booking policy) are the wizard's, and the server applies the same rules
 * again in `requestBookingReschedule`; this form only keeps a doomed request
 * from being sent. [calendar] and [policy] are null while those reads are in
 * flight, which shows a loading cue instead of a form that would change under
 * the household's fingers.
 */
@Composable
private fun RescheduleProposalForm(
    serviceId: String?,
    sending: Boolean,
    error: String?,
    nowMs: Long,
    calendar: BusinessCalendar?,
    policy: BookingPolicy?,
    onSend: (proposal: RescheduleProposal, reason: String?) -> Unit,
) {
    val type = LocalKinfolkTypography.current
    var showForm by remember { mutableStateOf(false) }
    var pickedDate by remember { mutableStateOf<LocalDate?>(null) }
    var modeChoice by remember { mutableStateOf<BookingMode?>(null) }
    var timeText by remember { mutableStateOf("") }
    var blockId by remember { mutableStateOf<String?>(null) }
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
    if (calendar == null || policy == null) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            CircularProgressIndicator(color = KinfolkBrand.KinfolkOrange, modifier = Modifier.size(20.dp))
            Text("Loading the days and times you can pick…", style = type.sansMeta)
        }
        KinGhostButton(
            label = "Never mind",
            onClick = { showForm = false },
            modifier = Modifier.fillMaxWidth(),
        )
        return
    }
    val today = remember(nowMs) {
        Instant.fromEpochMilliseconds(nowMs).toLocalDateTime(TimeZone.currentSystemDefault()).date
    }
    val horizonEnd = remember(today) { bookingHorizonEnd(today) }
    val timeZoneId = calendar.timeZone.ifBlank { FALLBACK_TIME_ZONE }
    val closedDates = remember(calendar, today) {
        closedDaysFor(
            calendar.closures.associate { it.date to it.name },
            calendar.weeklyHours,
            today,
            BOOKING_HORIZON_DAYS,
        )
    }
    val modes = remember(policy, serviceId) { rescheduleModes(policy, serviceId) }
    val mode = modeChoice?.takeIf { it in modes.modes } ?: modes.initial
    val startTimeService = serviceId != null && serviceId in policy.startTimeServiceIds
    val openBlocks = remember(pickedDate, mode, policy, timeZoneId, nowMs) {
        val day = pickedDate
        if (day == null || mode != BookingMode.TimeBlock) emptyList()
        else blockChoices(day, policy.timeBlocks, nowMs, timeZoneId)
    }
    // A block picked for one day may be gone on another (it has passed today).
    val effectiveBlockId = blockId?.takeIf { id -> openBlocks.any { it.block.id == id } }
    Text("New date", style = type.sansLabel)
    SimpleMonthPicker(
        selectedDates = listOfNotNull(pickedDate),
        onToggle = { pickedDate = if (pickedDate == it) null else it },
        today = today,
        horizonEnd = horizonEnd,
        closedDates = closedDates,
    )
    if (modes.modes.size > 1) {
        Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
            KinChip(
                label = "Time Blocks",
                selected = mode == BookingMode.TimeBlock,
                onClick = { modeChoice = BookingMode.TimeBlock },
            )
            KinChip(
                label = "A Specific Time",
                selected = mode == BookingMode.SpecificTime,
                onClick = { modeChoice = BookingMode.SpecificTime },
            )
        }
    }
    if (pickedDate == null) {
        Text("Pick a day to see the times.", style = type.sansMeta)
    } else if (mode == BookingMode.TimeBlock) {
        if (openBlocks.isEmpty()) {
            Text("No blocks left this day.", style = type.sansMeta)
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
                openBlocks.forEach { choice ->
                    KinChip(
                        label = timeBlockLabel(choice.block),
                        selected = effectiveBlockId == choice.block.id,
                        onClick = { blockId = choice.block.id },
                    )
                }
            }
        }
    } else {
        KinField(
            value = timeText,
            onValueChange = { timeText = it },
            label = "Time (HH:MM)",
            enabled = !sending,
            modifier = Modifier.fillMaxWidth(),
            fieldTestTag = "rescheduleTime",
        )
    }
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
            val result = resolveProposal(
                day = pickedDate,
                mode = mode,
                time = timeText,
                blockId = effectiveBlockId,
                blocks = policy.timeBlocks,
                weekly = calendar.weeklyHours,
                timeZoneId = timeZoneId,
                nowMs = nowMs,
                startTimeService = startTimeService,
            )
            val proposal = result.proposal
            val trouble = result.problem ?: rescheduleProblem(proposal?.startMs, nowMs)
            localProblem = trouble
            if (trouble == null && proposal != null) {
                onSend(proposal, reason.trim().takeIf { it.isNotEmpty() })
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
/**
 * #1283: what the household already told its Auntie about this visit. The
 * booking wizard's note, then each saved note with the time it was written.
 * A load that failed says so and keeps the rest of the screen; nothing here
 * can hide the note box below it.
 */
@Composable
private fun SavedNotesCard(savedNotes: BookingNotes?, error: Boolean) {
    val type = LocalKinfolkTypography.current
    GlassCard(
        modifier = Modifier.fillMaxWidth().testTag("savedNotes"),
        contentPadding = PaddingValues(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            Text("Your notes", style = type.heritageSection)
            when {
                savedNotes == null && error -> Text(
                    "We couldn't load your notes.",
                    style = type.sansMeta,
                    color = KinfolkBrand.SnuggleCoral,
                )
                savedNotes == null -> Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
                ) {
                    CircularProgressIndicator(color = KinfolkBrand.KinfolkOrange, modifier = Modifier.size(20.dp))
                    Text("Loading your notes…", style = type.sansMeta)
                }
                savedNotes.bookingNote == null && savedNotes.notes.isEmpty() ->
                    Text("Nothing yet.", style = type.sansMeta)
                else -> {
                    savedNotes.bookingNote?.let { note ->
                        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
                            Text("When you booked", style = type.sansLabel)
                            Text(note, style = type.sansBody)
                        }
                    }
                    savedNotes.notes.forEach { n ->
                        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
                            noteWrittenAt(n.createdAtMs).takeIf { it.isNotEmpty() }?.let {
                                Text(it, style = type.sansLabel)
                            }
                            Text(n.body, style = type.sansBody)
                        }
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
    heldByReschedule: Boolean,
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

            if (heldByReschedule && !pending && kinCare.isAwaitingVisit()) {
                // #1299: say why the button is not here.
                Text(
                    "You can ask to cancel once Tribe Tails answers your new time.",
                    style = type.sansMeta,
                    color = KinfolkBrand.NavyMuted,
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

/** #1298: the status row says the same word as the list and Home pills, in sentence case. */
private fun statusLabel(b: Booking): String =
    b.status.label().lowercase().replaceFirstChar { it.uppercase() }
