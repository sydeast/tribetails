package com.tribetails.auntieos.web.screens.sessions

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
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
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Undo2
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.observability.runCatchingCancellable
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.AuntieSpinner
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.time.Clock
import kotlin.time.ExperimentalTime
import kotlin.time.Instant

/**
 * #2250, operator ruling 2026-11-14: "A short Undo departed. For a few minutes
 * after Departed, Undo departed puts the visit back to Arrived; the household
 * is not told."
 *
 * A departure completes the visit on the server (#2123) and the rules refuse
 * every client the move back, so the undo is the `setVisitLifecycle` callable's
 * `UNDO_DEPARTED` action (`FirestoreClient.undoDeparted`), never a patch.
 *
 * NO NUMBER LIVES HERE. How long "a few minutes" is belongs to the server
 * (`functions/src/lib/visitLifecycle.ts`, `UNDO_DEPARTED_WINDOW_MS`). The
 * departure trigger stamps the moment the undo closes on the visit as
 * `undoDepartedUntil`, and this file only compares that moment with now.
 */

/** When this visit's undo closes, in epoch ms, or null when the server opened none. */
@OptIn(ExperimentalTime::class)
internal fun undoDepartedUntilMs(raw: String): Long? {
    val iso = raw.trim()
    if (iso.isEmpty()) return null
    return runCatchingCancellable { Instant.parse(iso).toEpochMilliseconds() }.getOrNull()
}

/** Is "Undo departed" offered on a visit with this status and stamp at [nowMs]? */
internal fun undoDepartedOpen(status: String, undoDepartedUntil: String, nowMs: Long): Boolean {
    val s = status.trim().uppercase()
    if (s != "DEPARTED" && s != "COMPLETED") return false
    val until = undoDepartedUntilMs(undoDepartedUntil) ?: return false
    return nowMs <= until
}

internal const val UNDO_DEPARTED_LABEL = "Undo departed"
internal const val UNDO_DEPARTED_CONFIRM_TITLE = "Undo departed?"
internal const val UNDO_DEPARTED_CONFIRM_YES = "Yes, undo departed"
internal const val UNDO_DEPARTED_WAITING = "Putting the visit back to Arrived…"
internal const val UNDO_DEPARTED_NO_ANSWER = "Check your connection and try again."

/** What the confirm says will happen. */
internal fun undoDepartedConfirmBody(household: String): String {
    val whose = household.trim().let { if (it.isEmpty()) "This visit" else "$it’s visit" }
    return "$whose will go back to Arrived, with the arrival time it already has. The household is not told."
}

/**
 * The sentence under the button when the undo did not happen. [message] is
 * already plain words on this client: the server's refusal as written, or
 * `plainCallableMessage`'s sentence for a call that got no answer (#1592).
 */
internal fun undoDepartedFailureWords(message: String): String {
    val reason = message.trim().ifEmpty { UNDO_DEPARTED_NO_ANSWER }
    return "Couldn’t undo the departure. $reason"
}

/**
 * The "Undo departed" block for an Auntie Time card: the button, its confirm,
 * the waiting row and the refusal. Draws nothing once the few minutes are up,
 * or on a visit that has not departed. The board is a live stream, so the card
 * moves back to Arrived by itself when the server has written it.
 *
 * @param undo the call itself; a parameter so a test can stand in for the server.
 */
@OptIn(ExperimentalTime::class)
@Composable
internal fun UndoDepartedButton(
    session: KinCareSession,
    household: String,
    modifier: Modifier = Modifier,
    nowMs: () -> Long = { Clock.System.now().toEpochMilliseconds() },
    undo: (suspend (String) -> WriteResult<Unit>)? = null,
) {
    val until = undoDepartedUntilMs(session.undoDepartedUntil)
    // Recomposes once, at the moment the window closes, so the button goes
    // while the board is left open.
    var closedTick by remember(session._id, until) { mutableStateOf(0) }
    LaunchedEffect(session._id, until) {
        if (until != null) {
            val left = until - nowMs()
            if (left >= 0) {
                delay(left + 1)
                closedTick++
            }
        }
    }
    val open = remember(session.status, until, closedTick) {
        undoDepartedOpen(session.status, session.undoDepartedUntil, nowMs())
    }

    var asked by remember(session._id) { mutableStateOf(false) }
    var saving by remember(session._id) { mutableStateOf(false) }
    var error by remember(session._id) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    // A refusal stays readable after the button has gone: the commonest one is
    // that the time ran out while the confirm was open.
    if (!open && !saving && error == null) return

    val client = remember { FirestoreClient() }
    val c = AuntieTheme.colors

    Column(modifier = modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (open) {
            GhostButton(
                label = UNDO_DEPARTED_LABEL,
                onClick = {
                    error = null
                    asked = true
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = !saving,
                leading = { Icon(Lucide.Undo2, contentDescription = null, modifier = Modifier.size(13.dp)) },
            )
        }
        if (saving) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AuntieSpinner(modifier = Modifier.size(16.dp))
                Text(UNDO_DEPARTED_WAITING, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        }
        error?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = c.error) }
    }

    AuntieDialog(
        visible = asked,
        title = UNDO_DEPARTED_CONFIRM_TITLE,
        onDismiss = { asked = false },
        maxWidth = 480.dp,
        footer = {
            GhostButton(label = "Not now", onClick = { asked = false })
            PrimaryButton(
                label = UNDO_DEPARTED_CONFIRM_YES,
                onClick = {
                    asked = false
                    saving = true
                    scope.launch {
                        val result = (undo ?: { id -> client.undoDeparted(id) })(session._id)
                        saving = false
                        if (result is WriteResult.Err) error = undoDepartedFailureWords(result.message)
                    }
                },
            )
        },
    ) {
        Text(undoDepartedConfirmBody(household), style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
    }
}
