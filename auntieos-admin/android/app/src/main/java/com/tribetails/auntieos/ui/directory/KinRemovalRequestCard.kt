package com.tribetails.auntieos.ui.directory

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.data.repository.KinRemovalRequestRow
import com.tribetails.auntieos.data.repository.KinRemovalResolution
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * #1408. A household asked to remove a Kin that has history; the office
 * archives it or declines. One card, drawn on the Kin's own profile
 * (KinDetailScreen) and in the queue on the schedule, the twin of the React
 * `components/KinRemovalRequests.tsx`. Every sentence here matches it.
 */

private val DATE: DateTimeFormatter = DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.US)

/** "Nov 2, 2026", in this device's zone, like the web's `toLocaleDateString`. */
fun kinRemovalDateLabel(epochMillis: Long?, zone: ZoneId = ZoneId.systemDefault()): String? =
    epochMillis?.let { DATE.format(Instant.ofEpochMilli(it).atZone(zone)) }

private fun KinRemovalRequestRow.label(): String = kinName ?: "This Kin"

/** One line: who asked, when. */
fun kinRemovalRequestedLine(r: KinRemovalRequestRow, zone: ZoneId = ZoneId.systemDefault()): String {
    val date = kinRemovalDateLabel(r.requestedAtMs, zone)
    return if (date != null) {
        "The household asked on $date to remove ${r.label()} from their profile."
    } else {
        "The household asked to remove ${r.label()} from their profile."
    }
}

/** What the screen says after an answer, from what the server actually did. */
fun kinRemovalResolvedMessage(res: KinRemovalResolution): String {
    val name = res.request.kinName ?: "The Kin"
    val told = if (res.householdNotified) {
        "The household has your answer."
    } else {
        "The message to the household did not go out, so tell them another way."
    }
    return if (res.decision == "archive") "$name is archived. $told" else "Declined. $name stays on the profile. $told"
}

/** The confirm line for [decision], the web dialog's sentence. */
fun kinRemovalConfirmLine(r: KinRemovalRequestRow, decision: String): String =
    if (decision == "archive") {
        "${r.label()} comes off the household's profile. Visits, invoices and KinTales are kept, and the household will be told."
    } else {
        "${r.label()} stays on the household's profile. The household will be told."
    }

/**
 * The warning band for one request. Archive and Decline each ask first, with
 * an optional note for the household; the confirm button reads "Working…"
 * and every control is locked while [inFlight]. [error] is the server's
 * refusal, shown under the controls.
 */
@Composable
fun KinRemovalRequestCard(
    request: KinRemovalRequestRow,
    inFlight: Boolean,
    locked: Boolean,
    error: String?,
    onResolve: (decision: String, note: String) -> Unit,
    modifier: Modifier = Modifier,
    title: String = "Removal requested",
) {
    val c = AuntieTheme.colors
    var deciding by remember(request.id) { mutableStateOf<String?>(null) }
    var note by remember(request.id) { mutableStateOf("") }
    AuntieBanner(modifier = modifier, tone = AuntieBannerTone.Warning, title = title) {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(kinRemovalRequestedLine(request), style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
            request.reason?.let {
                Text("Reason: $it", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
            val decision = deciding
            if (decision == null) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PrimaryButton(label = "Archive", onClick = { deciding = "archive" }, enabled = !locked)
                    GhostButton(label = "Decline", onClick = { deciding = "decline" }, enabled = !locked)
                }
            } else {
                Text(kinRemovalConfirmLine(request, decision), style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
                AuntieField(
                    value = note,
                    onValueChange = { note = it.take(500) },
                    label = "Note for the household (optional)",
                    singleLine = false,
                    enabled = !locked,
                    modifier = Modifier.fillMaxWidth(),
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PrimaryButton(
                        label = if (inFlight) "Working…" else if (decision == "archive") "Archive it" else "Send the decline",
                        onClick = { onResolve(decision, note) },
                        enabled = !locked,
                        loading = inFlight,
                    )
                    GhostButton(label = "Cancel", onClick = { deciding = null }, enabled = !locked)
                }
            }
            error?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = c.error) }
        }
    }
}
