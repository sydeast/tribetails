package com.tribetails.auntieos.web.screens.schedule

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.VisitInternalNote
import com.tribetails.auntieos.web.data.VisitInternalNotes
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.observability.rememberReportingScope
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieCheckbox
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.MultilineField
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import kotlinx.coroutines.launch
import kotlin.time.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

/**
 * #1580: the visit's ONE list of internal notes, the panel the booking sheet and
 * the Kin Care detail both show, and the same list web Bookings, web Auntie Time
 * and Android read. Before #1580 the console streamed a notes path that is
 * stubbed on the desktop transport, and the Kin Care detail showed the session's
 * own notes text: two stores, neither complete.
 *
 * Operator ruling, 2026-11-05 docket: "two kinds, shared and admin-only. The
 * writer marks each note. Aunties see only shared notes." The server filters
 * the list on the caller's claim and says whether to offer the mark, so this
 * panel never decides who sees what.
 */
@Composable
fun VisitInternalNotesPanel(
    client: FirestoreClient,
    sessionId: String,
    zone: TimeZone,
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    val scope = rememberReportingScope()
    var reload by remember(sessionId) { mutableStateOf(0) }
    var loaded by remember(sessionId) { mutableStateOf<WriteResult<VisitInternalNotes>?>(null) }
    var input by remember(sessionId) { mutableStateOf("") }
    var adminOnly by remember(sessionId) { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var saveError by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(sessionId, reload) {
        loaded = null
        loaded = client.listVisitInternalNotes(sessionId)
    }
    val ready = (loaded as? WriteResult.Ok)?.value
    val canMark = ready != null && ready.canMarkAdminOnly && ready.hasBookingRecord

    DenPanel(
        title = "Internal notes",
        subtitle = "Staff only. The household never sees these.",
        modifier = modifier,
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            when (val r = loaded) {
                null -> Text("Loading the notes…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                is WriteResult.Err -> AuntieBanner(tone = AuntieBannerTone.Error, title = "Could not load the notes") {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(r.message, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                        GhostButton(label = "Try again", onClick = { reload++ })
                    }
                }
                is WriteResult.Ok -> if (r.value.notes.isEmpty()) {
                    Text("No internal notes yet.", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                } else {
                    r.value.notes.forEach { note ->
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(10.dp))
                                .background(c.surfaceGlass)
                                .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(10.dp))
                                .padding(10.dp),
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Text(note.body, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                            Text(visitNoteByline(note, zone), style = AuntieTheme.typography.labelSmall, color = c.textDim)
                        }
                    }
                }
            }
            MultilineField(
                value = input,
                onValueChange = { input = it },
                label = "Add an internal note",
                placeholder = "Hidden from the household",
                minLines = 3,
                modifier = Modifier.fillMaxWidth(),
            )
            if (canMark) {
                AuntieCheckbox(
                    checked = adminOnly,
                    onCheckedChange = { adminOnly = it },
                    label = "Admin only (Aunties will not see it)",
                    enabled = !saving,
                )
            }
            PrimaryButton(
                label = if (saving) "Saving" else "Add note",
                enabled = !saving && input.isNotBlank() && loaded != null,
                loading = saving,
                onClick = {
                    scope.launch {
                        saving = true
                        saveError = null
                        saved = null
                        when (val w = client.addVisitInternalNote(sessionId, input, adminOnly = canMark && adminOnly)) {
                            is WriteResult.Ok -> {
                                input = ""
                                adminOnly = false
                                saved = if (w.value == "adminOnly") "Note added. Only you can see it." else "Note added for staff."
                                reload++
                            }
                            is WriteResult.Err -> saveError = w.message
                        }
                        saving = false
                    }
                },
                modifier = Modifier.fillMaxWidth(),
            )
            saved?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = c.textDim) }
            saveError?.let { err ->
                AuntieBanner(tone = AuntieBannerTone.Error, title = "Couldn't add the note") {
                    Text(err, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
            }
        }
    }
}

/** "Admin only · Syd · Nov 5, 3:00 PM"; the session's older text reads "On the visit record". */
internal fun visitNoteByline(note: VisitInternalNote, zone: TimeZone): String {
    if (note.source == "visitRecord") return "On the visit record"
    val who = note.authorName?.takeIf { it.isNotBlank() } ?: when (note.authorRole) {
        "auntie" -> "Auntie"
        "admin" -> "Office"
        else -> "Staff"
    }
    val whenText = note.createdAtMs?.let { ms ->
        val t = Instant.fromEpochMilliseconds(ms).toLocalDateTime(zone)
        val month = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")[t.monthNumber - 1]
        val h12 = if (t.hour % 12 == 0) 12 else t.hour % 12
        val ampm = if (t.hour < 12) "AM" else "PM"
        "$month ${t.dayOfMonth}, $h12:${t.minute.toString().padStart(2, '0')} $ampm"
    }
    return listOfNotNull(if (note.visibility == "adminOnly") "Admin only" else null, who, whenText).joinToString(" · ")
}
