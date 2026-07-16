package com.tribetails.auntieos.web.screens.schedule

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import com.tribetails.auntieos.web.observability.rememberReportingScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tribetails.auntieos.web.data.AuthClient
import com.tribetails.auntieos.web.data.BookingNote
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.StaffMember
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.MultilineField
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ServicePill
import com.tribetails.auntieos.web.ui.components.serviceTone
import kotlinx.coroutines.launch
import kotlin.time.Clock
import kotlin.time.Duration.Companion.minutes
import kotlin.time.ExperimentalTime
import kotlin.time.Instant
import kotlinx.datetime.LocalDateTime
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toInstant
import kotlinx.datetime.toLocalDateTime

private const val NOTE_CUTOFF_MS: Long = 3L * 60L * 60L * 1000L

@OptIn(ExperimentalTime::class)
@Composable
fun BookingDetailModal(
    session: KinCareSession,
    onDismiss: () -> Unit,
    client: FirestoreClient,
    nowMs: () -> Long = { Clock.System.now().toEpochMilliseconds() },
) {
    val c = AuntieTheme.colors
    val scope = rememberReportingScope()
    val localZone = remember { TimeZone.currentSystemDefault() }
    val bookingId = session.sourceBookingId.ifBlank { session._id }

    val kinfolkNotes by remember(session.kinfolkId, bookingId) {
        client.bookingNotesStream(session.kinfolkId, bookingId, internal = false)
    }.collectAsState(initial = FirestoreResult.Loading)
    val internalNotes by remember(session.kinfolkId, bookingId) {
        client.bookingNotesStream(session.kinfolkId, bookingId, internal = true)
    }.collectAsState(initial = FirestoreResult.Loading)

    var kinfolkInput by remember { mutableStateOf("") }
    var internalInput by remember { mutableStateOf("") }
    var savingKinfolk by remember { mutableStateOf(false) }
    var savingInternal by remember { mutableStateOf(false) }
    var saveError by remember { mutableStateOf<String?>(null) }

    // Reschedule (wires the Stage-1 rescheduleBooking callable, §A.9). Prefilled from
    // the current start; end is recomputed from the service duration. Real write.
    var reschedDate by remember(session._id) { mutableStateOf(isoDatePart(session.startTime)) }
    var reschedTime by remember(session._id) { mutableStateOf(isoTimePart(session.startTime)) }
    var rescheduling by remember { mutableStateOf(false) }
    var reschedError by remember { mutableStateOf<String?>(null) }

    // Assigned Auntie (assignAuntie callable). Only envelope visits carry the
    // batch/visit ids the callable needs; legacy flat sessions hide the row.
    // Assignment lives on the kinCares visit doc (never mirrored onto
    // kin_care_sessions), so it is read once here rather than off [session].
    val auth = remember { AuthClient() }
    val authUser by auth.authStateStream().collectAsState(initial = null)
    val assignBatchId = session.kinCareBatchId.orEmpty()
    val assignVisitId = session.kinCareVisitId.orEmpty()
    val canAssign = session.kinfolkId.isNotBlank() && assignBatchId.isNotBlank() && assignVisitId.isNotBlank()
    var assignedUid by remember(session._id) { mutableStateOf<String?>(null) }
    var assignedName by remember(session._id) { mutableStateOf<String?>(null) }
    var assigning by remember { mutableStateOf(false) }
    var assignError by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(session._id) {
        if (canAssign) {
            val r = client.kinCareAssignment(session.kinfolkId, assignBatchId, assignVisitId)
            if (r is WriteResult.Ok) {
                assignedUid = r.value?.assignedAuntieUid
                assignedName = r.value?.auntieDisplayName
            }
        }
    }
    // Staff roster for the picker. Loaded once, the first time the operator
    // opens the assign control (not on every modal open), then remembered for
    // the life of the modal. A load error shows inline with a retry.
    var pickerOpen by remember(session._id) { mutableStateOf(false) }
    var staff by remember { mutableStateOf<List<StaffMember>?>(null) }
    var staffError by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(pickerOpen, staffError) {
        if (pickerOpen && staff == null && staffError == null) {
            when (val r = client.listStaff()) {
                is WriteResult.Ok -> staff = r.value
                is WriteResult.Err -> staffError = r.message
            }
        }
    }
    // Optimistic swap with revert: the row flips immediately, the callable runs,
    // and an Err restores the previous Auntie + surfaces the message inline.
    // On Ok we re-read the doc so the canonical staff display name replaces the
    // optimistic placeholder.
    val changeAssignee: (String?, String?) -> Unit = changeAssignee@{ uid, optimisticName ->
        if (!canAssign || assigning) return@changeAssignee
        val prevUid = assignedUid
        val prevName = assignedName
        assignedUid = uid
        assignedName = optimisticName
        scope.launch {
            assigning = true
            assignError = null
            when (val r = client.assignAuntie(session.kinfolkId, assignBatchId, assignVisitId, uid)) {
                is WriteResult.Ok -> {
                    val canon = (client.kinCareAssignment(session.kinfolkId, assignBatchId, assignVisitId) as? WriteResult.Ok)?.value
                    if (canon != null) {
                        assignedUid = canon.assignedAuntieUid
                        assignedName = canon.auntieDisplayName
                    }
                }
                is WriteResult.Err -> {
                    assignedUid = prevUid
                    assignedName = prevName
                    assignError = r.message
                }
            }
            assigning = false
        }
    }

    val startMs = parseIsoToMs(session.startTime, localZone)
    val locked = startMs != null && nowMs() >= (startMs - NOTE_CUTOFF_MS)

    // Backdrop + side panel
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color.Black.copy(alpha = 0.45f)),
        contentAlignment = Alignment.CenterEnd,
    ) {
        Box(
            modifier = Modifier
                .fillMaxHeight()
                .width(480.dp)
                .clip(RoundedCornerShape(topStart = 18.dp, bottomStart = 18.dp))
                .background(c.background)
                .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(topStart = 18.dp, bottomStart = 18.dp))
                .padding(20.dp),
        ) {
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                // ── Header: kicker + serif title + close ──
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.Top,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(
                            text = "Visit detail",
                            style = AuntieTheme.typography.mono.copy(letterSpacing = 1.6.sp, fontSize = 11.sp),
                            color = c.primary,
                        )
                        Spacer(Modifier.height(4.dp))
                        Text(
                            text = session.serviceType.ifBlank { "Kin Care Visit" },
                            style = AuntieTheme.typography.headlineMedium,
                            color = c.textPrimary,
                        )
                    }
                    GhostButton(label = "Close", onClick = onDismiss)
                }

                // ── Facts panel ──
                DenPanel(title = "Booking") {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        FactRow("Kinfolk", session.kinfolkName.ifBlank { "Unnamed" })
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("When", style = AuntieTheme.typography.labelSmall, color = c.textDim)
                            Text(
                                text = displayDateTime(session.startTime, localZone),
                                style = AuntieTheme.typography.bodyMedium,
                                color = c.textPrimary,
                            )
                        }
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("Service", style = AuntieTheme.typography.labelSmall, color = c.textDim)
                            ServicePill(session.serviceType, serviceTone(session.serviceType))
                        }
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("Status", style = AuntieTheme.typography.labelSmall, color = c.textDim)
                            AuntieStatusPill(label = session.status.ifBlank { "SCHEDULED" }, showDot = true)
                        }
                        if (canAssign) {
                            FactRow("Assigned Auntie", assignedName ?: if (assignedUid != null) "Assigned" else "Unassigned")
                            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                GhostButton(
                                    label = when {
                                        assigning  -> "Saving"
                                        pickerOpen -> "Hide the list"
                                        else       -> "Choose an Auntie"
                                    },
                                    enabled = !assigning,
                                    onClick = { pickerOpen = !pickerOpen },
                                )
                                GhostButton(
                                    label = "Unassign",
                                    enabled = !assigning && assignedUid != null,
                                    onClick = { changeAssignee(null, null) },
                                )
                            }
                            if (pickerOpen) {
                                val roster = staff
                                when {
                                    staffError != null -> {
                                        AuntieBanner(tone = AuntieBannerTone.Error, title = "Couldn't load the roster") {
                                            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                                Text(staffError!!, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                                                GhostButton(label = "Try again", onClick = { staffError = null })
                                            }
                                        }
                                    }
                                    roster == null -> Text(
                                        text = "Loading the roster",
                                        style = AuntieTheme.typography.bodySmall,
                                        color = c.textDim,
                                    )
                                    roster.isEmpty() -> Text(
                                        text = "No staff on the roster yet.",
                                        style = AuntieTheme.typography.bodySmall,
                                        color = c.textDim,
                                    )
                                    else -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                        roster.forEach { member ->
                                            val isMe = member.uid == authUser?.uid
                                            val label = if (isMe) "${member.pickerLabel} (you)" else member.pickerLabel
                                            GhostButton(
                                                label = label,
                                                enabled = !assigning && member.uid != assignedUid,
                                                onClick = {
                                                    pickerOpen = false
                                                    changeAssignee(member.uid, if (isMe) "You" else member.pickerLabel)
                                                },
                                            )
                                        }
                                    }
                                }
                            }
                            assignError?.let { err ->
                                AuntieBanner(tone = AuntieBannerTone.Error, title = "Couldn't change the Auntie") {
                                    Text(err, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                                }
                            }
                        }
                    }
                }

                // ── Reschedule (real rescheduleBooking write) ──
                // Only before the visit starts (SCHEDULED). Replaces the old "drag not
                // wired" dead-end for the common case; drag physics stay gated separately.
                val canReschedule = session.status.uppercase().let { it == "SCHEDULED" || it.isBlank() }
                if (canReschedule) {
                    DenPanel(
                        title = "Reschedule",
                        subtitle = "Move this visit to a new date and time.",
                    ) {
                        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                BottomBorderField(reschedDate, { reschedDate = it }, label = "Date (YYYY-MM-DD)", modifier = Modifier.weight(1f))
                                BottomBorderField(reschedTime, { reschedTime = it }, label = "Time (HH:MM)", modifier = Modifier.weight(1f))
                            }
                            PrimaryButton(
                                label = if (rescheduling) "Rescheduling" else "Reschedule visit",
                                enabled = !rescheduling && reschedDate.length == 10 && reschedTime.length == 5,
                                onClick = {
                                    val times = buildRescheduleTimes(reschedDate, reschedTime, session.serviceDurationMinutes, localZone)
                                    if (times == null) {
                                        reschedError = "Enter a valid date (YYYY-MM-DD) and time (HH:MM)."
                                    } else {
                                        scope.launch {
                                            rescheduling = true
                                            reschedError = null
                                            when (val r = client.rescheduleBooking(session._id, times.first, times.second)) {
                                                is WriteResult.Ok -> onDismiss()
                                                is WriteResult.Err -> reschedError = r.message
                                            }
                                            rescheduling = false
                                        }
                                    }
                                },
                                modifier = Modifier.fillMaxWidth(),
                            )
                            reschedError?.let { err ->
                                AuntieBanner(tone = AuntieBannerTone.Error, title = "Couldn't reschedule") {
                                    Text(err, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                                }
                            }
                        }
                    }
                }

                // ── Kinfolk-facing note ──
                DenPanel(
                    title = "Kinfolk-facing note",
                    subtitle = "Visible to kinfolk. Editable until 3 hours before the visit.",
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        NotesList(state = kinfolkNotes, emptyMsg = "No kinfolk-facing notes yet.")
                        MultilineField(
                            value = kinfolkInput,
                            onValueChange = { kinfolkInput = it },
                            label = "Add note",
                            // TODO(copy): kinfolk-facing placeholder example needs user-authored wording.
                            placeholder = "Add a note for the kinfolk",
                            minLines = 3,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        if (locked) {
                            AuntieBanner(tone = AuntieBannerTone.Warning) {
                                Text(
                                    "Notes locked: the visit starts in under 3 hours.",
                                    style = AuntieTheme.typography.bodySmall,
                                    color = c.textDim,
                                )
                            }
                        }
                        PrimaryButton(
                            label = if (savingKinfolk) "Saving" else "Save kinfolk-facing note",
                            enabled = !locked && !savingKinfolk && kinfolkInput.isNotBlank(),
                            onClick = {
                                scope.launch {
                                    savingKinfolk = true
                                    saveError = null
                                    val r = client.addBookingNote(
                                        kinfolkId = session.kinfolkId,
                                        bookingId = bookingId,
                                        body = kinfolkInput.trim(),
                                        internal = false,
                                    )
                                    when (r) {
                                        is WriteResult.Ok -> kinfolkInput = ""
                                        is WriteResult.Err -> saveError = r.message
                                    }
                                    savingKinfolk = false
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }

                // ── Internal note ──
                DenPanel(
                    title = "Internal note (admin only)",
                    subtitle = "Hidden from kinfolk. Visible to staff on every session of this booking.",
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        NotesList(state = internalNotes, emptyMsg = "No internal notes yet.")
                        MultilineField(
                            value = internalInput,
                            onValueChange = { internalInput = it },
                            label = "Add internal note",
                            placeholder = "Context for staff",
                            minLines = 3,
                            modifier = Modifier.fillMaxWidth(),
                        )
                        PrimaryButton(
                            label = if (savingInternal) "Saving" else "Save internal note",
                            enabled = !savingInternal && internalInput.isNotBlank(),
                            onClick = {
                                scope.launch {
                                    savingInternal = true
                                    saveError = null
                                    val r = client.addBookingNote(
                                        kinfolkId = session.kinfolkId,
                                        bookingId = bookingId,
                                        body = internalInput.trim(),
                                        internal = true,
                                    )
                                    when (r) {
                                        is WriteResult.Ok -> internalInput = ""
                                        is WriteResult.Err -> saveError = r.message
                                    }
                                    savingInternal = false
                                }
                            },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }

                // Fail loud: surface any write error inline rather than swallowing it.
                saveError?.let { err ->
                    AuntieBanner(tone = AuntieBannerTone.Error, title = "Couldn't save note") {
                        Text(err, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }
                }
            }
        }
    }
}

@Composable
private fun FactRow(label: String, value: String) {
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = AuntieTheme.typography.labelSmall, color = c.textDim)
        Text(value, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
    }
}

@Composable
private fun NotesList(state: FirestoreResult<List<BookingNote>>, emptyMsg: String) {
    val c = AuntieTheme.colors
    when (state) {
        is FirestoreResult.Loading -> Text("Loading notes", style = AuntieTheme.typography.bodySmall, color = c.textDim)
        is FirestoreResult.Error -> AuntieBanner(tone = AuntieBannerTone.Error) {
            Text("Could not load notes: ${state.message}", style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
        is FirestoreResult.Data<List<BookingNote>> -> {
            if (state.value.isEmpty()) {
                Text(emptyMsg, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    state.value.sortedBy { it.createdAtMs ?: 0L }.forEach { note ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(10.dp))
                                .background(c.surfaceGlass)
                                .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(10.dp))
                                .padding(10.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(note.body, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary, modifier = Modifier.weight(1f).padding(end = 8.dp))
                            Text(note.authorRole, style = AuntieTheme.typography.labelSmall, color = c.textDim)
                        }
                    }
                }
            }
        }
    }
}

/** Date part ("yyyy-MM-dd") of a stored ISO start, for reschedule prefill. */
internal fun isoDatePart(iso: String): String = if (iso.length >= 10) iso.substring(0, 10) else ""

/** Time part ("HH:mm") of a stored ISO start, for reschedule prefill. */
internal fun isoTimePart(iso: String): String =
    if (iso.length >= 16 && iso[10] == 'T') iso.substring(11, 16) else ""

/**
 * Build the (startIso, endIso) pair for a reschedule from a local date+time, with
 * the end derived from the service duration (default 30m). Returns null on a
 * malformed date/time so the caller can fail loud rather than write garbage. Pure.
 */
@OptIn(ExperimentalTime::class)
internal fun buildRescheduleTimes(date: String, time: String, durationMinutes: Int, zone: TimeZone): Pair<String, String>? {
    if (date.length != 10 || time.length != 5) return null
    val startIso = "${date}T${time}:00"
    val startLdt = runCatching { LocalDateTime.parse(startIso) }.getOrNull() ?: return null
    val dur = if (durationMinutes > 0) durationMinutes else 30
    val endLdt = startLdt.toInstant(zone).plus(dur.minutes).toLocalDateTime(zone)
    return startIso to "${endLdt.date}T${pad2(endLdt.hour)}:${pad2(endLdt.minute)}:00"
}

private fun pad2(n: Int): String = n.toString().padStart(2, '0')

/**
 * Parse a stored ISO timestamp to epoch millis. Prefers a true instant parse
 * (UTC "...Z" or offset). Falls back to interpreting a timezone-less local string
 * in the auntie's local zone.
 */
@OptIn(ExperimentalTime::class)
private fun parseIsoToMs(iso: String, zone: TimeZone): Long? {
    if (iso.isBlank()) return null
    runCatching { return Instant.parse(iso).toEpochMilliseconds() }
    return try {
        LocalDateTime.parse(iso).toInstant(zone).toEpochMilliseconds()
    } catch (_: Throwable) {
        null
    }
}

/**
 * Human "Mon, May 27 at 2:00 PM" in the auntie's LOCAL zone. Converts a UTC/offset
 * instant before formatting so the time reads local, not the literal UTC hour. Falls
 * back to the raw input when nothing parses (never fabricates a time).
 */
@OptIn(ExperimentalTime::class)
private fun displayDateTime(iso: String, zone: TimeZone): String {
    if (iso.isBlank()) return "Not set"
    val ldt = runCatching { Instant.parse(iso).toLocalDateTime(zone) }.getOrNull()
        ?: runCatching { LocalDateTime.parse(iso) }.getOrNull()
        ?: return iso
    val dow = ldt.date.dayOfWeek.name.take(3).lowercase().replaceFirstChar(Char::titlecase)
    val month = ldt.date.month.name.take(3).lowercase().replaceFirstChar(Char::titlecase)
    val ampm = if (ldt.hour >= 12) "PM" else "AM"
    val hour12 = when (ldt.hour % 12) { 0 -> 12; else -> ldt.hour % 12 }
    val minute = ldt.minute.toString().padStart(2, '0')
    return "$dow, $month ${ldt.date.day} at $hour12:$minute $ampm"
}
