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
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinField
import com.kinfolk.portal.components.KinGhostButton
import com.kinfolk.portal.portal.Booking
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.isAwaitingVisit
import com.kinfolk.portal.screens.schedule.util.ReviewRow
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import com.kinfolk.portal.util.relativeTime
import kotlinx.coroutines.launch
import kotlin.time.Clock

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
                ReviewRow("Service", kinCare.serviceType ?: "TBD")
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

        // Cancellation ask — only while the visit is still ahead (requested or
        // confirmed). Once an ask is pending, the action never comes back.
        if (kinCare.isAwaitingVisit()) {
            CancelRequestSection(
                pending = cancelPending,
                sending = cancelSending,
                error = cancelError,
                onSend = onSendCancelRequest,
            )
        }
    }
}

/**
 * "Need to cancel?" card. Tap reveals an inline confirm with an optional
 * short reason; the ask does not change the visit status. When [pending],
 * renders a quiet caption instead of any action.
 */
@Composable
private fun CancelRequestSection(
    pending: Boolean,
    sending: Boolean,
    error: String?,
    onSend: (reason: String?) -> Unit,
) {
    val type = LocalKinfolkTypography.current
    GlassCard(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            Text("Need to cancel?", style = type.heritageSection)
            if (pending) {
                Text(
                    "Cancellation requested. We'll confirm soon.",
                    style = type.sansMeta,
                    color = KinfolkBrand.NavyMuted,
                )
            } else {
                var showConfirm by remember { mutableStateOf(false) }
                var reason by remember { mutableStateOf("") }
                if (!showConfirm) {
                    KinGhostButton(
                        label = "Request cancellation",
                        onClick = { showConfirm = true },
                        modifier = Modifier.fillMaxWidth(),
                    )
                } else {
                    Text(
                        "We'll let your Auntie know. The visit stays on the books until she confirms.",
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
