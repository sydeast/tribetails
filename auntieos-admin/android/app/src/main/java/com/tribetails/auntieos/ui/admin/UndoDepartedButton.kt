package com.tribetails.auntieos.ui.admin

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
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Undo2
import com.google.firebase.functions.FirebaseFunctionsException
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.domain.UNDO_DEPARTED_CONFIRM_TITLE
import com.tribetails.auntieos.domain.UNDO_DEPARTED_CONFIRM_YES
import com.tribetails.auntieos.domain.UNDO_DEPARTED_LABEL
import com.tribetails.auntieos.domain.UNDO_DEPARTED_WAITING
import com.tribetails.auntieos.domain.undoDepartedConfirmBody
import com.tribetails.auntieos.domain.undoDepartedFailureWords
import com.tribetails.auntieos.domain.undoDepartedOpen
import com.tribetails.auntieos.domain.undoDepartedUntilMs
import com.tribetails.auntieos.ui.components.AuntieModal
import com.tribetails.auntieos.ui.components.AuntieSpinner
import com.tribetails.auntieos.ui.components.AuntieTextBtn
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch

/**
 * #2250, operator ruling 2026-11-14: "Undo departed" on a visit that has just
 * been departed. One self-contained block for the Auntie Time card and the
 * Home card: the button, its confirm, the waiting row and the refusal. It
 * draws nothing once the few minutes are up, or on a visit that has not
 * departed.
 *
 * The undo is the server's (`KinCareRepository.undoDeparted`), so it needs a
 * connection and can take several seconds on a cold start: the row with the
 * spinner is what says so. When the window closes is read off the visit
 * (`undoDepartedUntil`, the server's stamp); see `domain/UndoDeparted.kt`.
 *
 * @param onUndone called once the visit is back at Arrived, so the screen re-reads.
 * @param undo the call itself; a parameter so a test can stand in for the server.
 * @param watch the visit's live status and stamp, for a row read before the stamp.
 */
@Composable
fun UndoDepartedButton(
    session: KinCareSession,
    household: String,
    onUndone: () -> Unit,
    modifier: Modifier = Modifier,
    nowMs: () -> Long = System::currentTimeMillis,
    undo: suspend (String) -> Result<Unit> = { AuntieOSApp.instance.kinCareRepository.undoDeparted(it) },
    watch: (String) -> Flow<Pair<String, String?>> = { AuntieOSApp.instance.kinCareRepository.observeUndoDeparted(it) },
) {
    // The board read this row once, straight after the Departed tap, and the
    // server stamps the window a moment later. A Departed row with no stamp is
    // watched until it has one. A row that carries one opens no listener.
    val needsWatch = session.status.trim().uppercase() == "DEPARTED" && session.undoDepartedUntil.isNullOrBlank()
    var live by remember(session.id) { mutableStateOf<Pair<String, String?>?>(null) }
    LaunchedEffect(session.id, needsWatch) {
        if (needsWatch) watch(session.id).collect { live = it }
    }
    val status = if (needsWatch) live?.first ?: session.status else session.status
    val stamp = if (needsWatch) live?.second else session.undoDepartedUntil
    val until = undoDepartedUntilMs(stamp)
    // Recomposes once, at the moment the window closes, so the button goes
    // while the screen is left open.
    var closedTick by remember(session.id, until) { mutableStateOf(0) }
    LaunchedEffect(session.id, until) {
        if (until != null) {
            val left = until - nowMs()
            if (left >= 0) {
                delay(left + 1)
                closedTick++
            }
        }
    }
    val open = remember(status, until, closedTick) { undoDepartedOpen(status, stamp, nowMs()) }

    var asked by remember(session.id) { mutableStateOf(false) }
    var saving by remember(session.id) { mutableStateOf(false) }
    var error by remember(session.id) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    // A refusal stays readable after the button has gone: the commonest one is
    // that the time ran out while the confirm was open.
    if (!open && !saving && error == null) return

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
                leading = { Icon(Lucide.Undo2, contentDescription = null, modifier = Modifier.size(14.dp)) },
            )
        }
        if (saving) {
            Row(
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                AuntieSpinner(modifier = Modifier.size(16.dp))
                Text(UNDO_DEPARTED_WAITING, color = AuntieTheme.colors.textDim)
            }
        }
        error?.let {
            Text(
                it,
                color = AuntieTheme.colors.error,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Assertive },
            )
        }
    }

    if (asked) {
        AuntieModal(
            onDismissRequest = { asked = false },
            title = UNDO_DEPARTED_CONFIRM_TITLE,
            confirmButton = {
                AuntieTextBtn(onClick = {
                    asked = false
                    saving = true
                    scope.launch {
                        val result = undo(session.id)
                        saving = false
                        result.onSuccess { onUndone() }.onFailure { e -> error = undoDepartedFailureWords(serverSentenceOf(e)) }
                    }
                }) { Text(UNDO_DEPARTED_CONFIRM_YES) }
            },
            dismissButton = { AuntieTextBtn(onClick = { asked = false }) { Text("Not now") } },
        ) {
            Text(undoDepartedConfirmBody(household))
        }
    }
}

/**
 * The server's own sentence, when the failure is the server saying no. Any
 * other failure (no signal, a timeout) carries a transport code for a message,
 * which is not something to show: null, and the caller says to check the
 * connection.
 */
private fun serverSentenceOf(e: Throwable): String? {
    val refusal = e as? FirebaseFunctionsException ?: return null
    return when (refusal.code) {
        FirebaseFunctionsException.Code.FAILED_PRECONDITION,
        FirebaseFunctionsException.Code.NOT_FOUND,
        FirebaseFunctionsException.Code.PERMISSION_DENIED,
        -> refusal.message
        else -> null
    }
}
