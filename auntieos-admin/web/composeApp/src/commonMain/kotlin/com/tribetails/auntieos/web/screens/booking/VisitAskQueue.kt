package com.tribetails.auntieos.web.screens.booking

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.CircleCheckBig
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.web.data.AskDecision
import com.tribetails.auntieos.web.data.ASK_NOTE_MAX
import com.tribetails.auntieos.web.data.CancelAsk
import com.tribetails.auntieos.web.data.RescheduleAsk
import com.tribetails.auntieos.web.data.ScheduleOverride
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.listCancelAsks
import com.tribetails.auntieos.web.data.listRescheduleAsks
import com.tribetails.auntieos.web.data.overridableScheduleRefusal
import com.tribetails.auntieos.web.data.resolveCancelAsk
import com.tribetails.auntieos.web.data.resolveRescheduleAsk
import com.tribetails.auntieos.web.observability.rememberReportingScope
import com.tribetails.auntieos.web.screens.LocalServiceCatalog
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.AuntieSpinner
import com.tribetails.auntieos.web.ui.components.EmptyHint
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.LoadErrorBanner
import com.tribetails.auntieos.web.ui.components.MultilineField
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.datetime.TimeZone

/**
 * #2243: Bookings listed new booking requests only. A household's ask to move a
 * visit to a new time, or to cancel one, had nowhere to be seen or answered on
 * the console, while admin web and Android list all three in Visit requests.
 *
 * These two queues arrive through the same callables admin web reads
 * (`listRescheduleRequests`, `listCancelRequests`): the asks live on each
 * household's own visits, and the server names the household and the KinCare.
 * The two are read independently and reported independently, so one failed
 * read never hides the other's rows and never reads as "nothing waiting".
 * Read again every [VISIT_ASK_REFRESH_MS], as web's poll floor is; an answered
 * row leaves the list the moment the server confirms it.
 */

/** Web's poll floor for the request queues (`VISIT_REQUESTS_REFRESH_MS`). */
const val VISIT_ASK_REFRESH_MS = 60_000L

/** Test tag on each ask's card. */
const val VISIT_ASK_ROW_TAG = "visit-ask-row"

/** What the console knows about the two ask queues. */
@Stable
class VisitAskQueueState {
    /** Null until that queue's first answer. */
    var reschedule: List<RescheduleAsk>? by mutableStateOf(null)
        internal set
    var cancel: List<CancelAsk>? by mutableStateOf(null)
        internal set
    var rescheduleError: String? by mutableStateOf(null)
        internal set
    var cancelError: String? by mutableStateOf(null)
        internal set
    /** A read is out. */
    var reading: Boolean by mutableStateOf(false)
        internal set
    /** The queues are read on this screen at all (not on the fake-data path, not for a sandbox admin). */
    var active: Boolean by mutableStateOf(true)
        internal set
    var generation: Int by mutableStateOf(0)
        private set
    /** The last answer's sentence, naming the household, kept until dismissed. */
    var outcome: String? by mutableStateOf(null)
    private val answered = mutableStateMapOf<String, Boolean>()

    /** Both queues have answered or failed at least once. */
    val settled: Boolean get() = (reschedule != null || rescheduleError != null) && (cancel != null || cancelError != null)

    val rows: List<VisitAsk>
        get() = mergeVisitAsks(reschedule.orEmpty(), cancel.orEmpty()).filter { answered[it.key()] != true }

    /** One line per queue whose latest read failed. */
    val failures: List<String>
        get() = listOfNotNull(
            rescheduleError?.let { "$RESCHEDULE_QUEUE_NAME: $it" },
            cancelError?.let { "$CANCEL_QUEUE_NAME: $it" },
        )

    /** Whether the Visit requests panel has anything of this queue to draw. */
    val needsPanel: Boolean
        get() = active && (!settled || failures.isNotEmpty() || rows.isNotEmpty() || outcome != null)

    fun retry() { generation++ }

    fun markAnswered(row: VisitAsk, message: String) {
        answered[row.key()] = true
        outcome = row.outcomeLine(message)
    }
}

/**
 * Reads both queues once, side by side. A failed queue keeps the rows it last
 * read (the error line says they may be out of date) and never reads as empty.
 */
suspend fun readVisitAsks(
    state: VisitAskQueueState,
    listReschedule: suspend () -> WriteResult<List<RescheduleAsk>> = { listRescheduleAsks() },
    listCancel: suspend () -> WriteResult<List<CancelAsk>> = { listCancelAsks() },
) {
    state.reading = true
    coroutineScope {
        val r = async { listReschedule() }
        val c = async { listCancel() }
        when (val res = r.await()) {
            is WriteResult.Ok -> { state.reschedule = res.value; state.rescheduleError = null }
            is WriteResult.Err -> state.rescheduleError = res.message.ifBlank { "the read did not land" }
        }
        when (val res = c.await()) {
            is WriteResult.Ok -> { state.cancel = res.value; state.cancelError = null }
            is WriteResult.Err -> state.cancelError = res.message.ifBlank { "the read did not land" }
        }
    }
    state.reading = false
}

/** The two queues, read now and every [VISIT_ASK_REFRESH_MS]. Nothing is read when [enabled] is false. */
@Composable
fun rememberVisitAskQueue(enabled: Boolean, refreshMs: Long = VISIT_ASK_REFRESH_MS): VisitAskQueueState {
    val state = remember { VisitAskQueueState() }
    state.active = enabled
    LaunchedEffect(enabled, state.generation) {
        if (!enabled) return@LaunchedEffect
        while (true) {
            readVisitAsks(state)
            delay(refreshMs)
        }
    }
    return state
}

/** What one answer came to. */
sealed interface VisitAskAnswer {
    data class Done(val message: String) : VisitAskAnswer
    /** The server's own sentence. [retry] is the override "Accept anyway" may send, when one is open. */
    data class Refused(val message: String, val retry: ScheduleOverride?) : VisitAskAnswer
}

/**
 * Sends one answer. Only an accepted move can be retried over a busy block or
 * another visit (#1100), and an override already sent is never offered twice.
 */
suspend fun answerVisitAsk(
    row: VisitAsk,
    decision: AskDecision,
    note: String,
    granted: Set<ScheduleOverride> = emptySet(),
): VisitAskAnswer = when (row) {
    is VisitAsk.Reschedule -> when (val r = resolveRescheduleAsk(row.ask, decision, note, granted)) {
        is WriteResult.Ok -> VisitAskAnswer.Done(rescheduleAnsweredMessage(decision, r.value))
        is WriteResult.Err -> VisitAskAnswer.Refused(
            r.message,
            overridableScheduleRefusal(r.code)?.takeIf { decision == AskDecision.ACCEPT && it !in granted },
        )
    }
    is VisitAsk.Cancel -> when (val r = resolveCancelAsk(row.ask, decision, note)) {
        is WriteResult.Ok -> VisitAskAnswer.Done(cancelAnsweredMessage(decision, r.value))
        is WriteResult.Err -> VisitAskAnswer.Refused(r.message, null)
    }
}

/**
 * The move and cancellation part of Visit requests: the cue while it reads, a
 * line per queue that did not load (with Retry), the last answer, and one card
 * per ask with Accept and Decline. [sandbox] reads nothing: a sandbox test
 * admin is refused both queues.
 */
@Composable
fun VisitAskSection(state: VisitAskQueueState, zone: TimeZone, sandbox: Boolean) {
    val c = AuntieTheme.colors
    var detail by remember { mutableStateOf<VisitAsk?>(null) }
    var sheet by remember { mutableStateOf<Pair<VisitAsk, AskDecision>?>(null) }

    if (sandbox) {
        EmptyHint("Move and cancellation requests aren't available in the sandbox.")
        return
    }
    if (!state.active) return
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        state.outcome?.let { said ->
            AuntieBanner(
                tone = AuntieBannerTone.Success,
                title = "Done",
                icon = Lucide.CircleCheckBig,
                onDismiss = { state.outcome = null },
            ) { Text(said, style = AuntieTheme.typography.bodySmall, color = c.textDim) }
        }
        if (!state.settled) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AuntieSpinner(modifier = Modifier.size(14.dp))
                Text("Checking for move and cancellation requests…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        }
        if (state.failures.isNotEmpty()) {
            LoadErrorBanner(
                title = "One of these queues didn't load",
                message = askQueueFailureText(state.failures),
                onRetry = { state.retry() },
                retrying = state.reading,
            )
        }
        state.rows.forEach { row ->
            VisitAskCard(
                row = row,
                zone = zone,
                onOpen = { detail = row },
                onDecide = { decision -> sheet = row to decision },
            )
        }
    }

    detail?.let { row ->
        VisitAskDetailDialog(
            row = row,
            zone = zone,
            onClose = { detail = null },
            onDecide = { decision -> detail = null; sheet = row to decision },
        )
    }
    sheet?.let { (row, decision) ->
        VisitAskDecisionDialog(
            row = row,
            decision = decision,
            zone = zone,
            onClose = { sheet = null },
            onAnswered = { message ->
                sheet = null
                state.markAnswered(row, message)
            },
        )
    }
}

@Composable
private fun VisitAskCard(row: VisitAsk, zone: TimeZone, onOpen: () -> Unit, onDecide: (AskDecision) -> Unit) {
    val c = AuntieTheme.colors
    val catalog = LocalServiceCatalog.current
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(VISIT_ASK_ROW_TAG)
            .clip(RoundedCornerShape(10.dp))
            .background(c.surface)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Column(
            modifier = Modifier.fillMaxWidth().clickable(onClickLabel = "Open the request", onClick = onOpen),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(row.kindLabel().uppercase(), style = AuntieTheme.typography.labelSmall, color = c.warning)
                Text(row.householdLabel(), style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
            }
            Text(row.subject(catalog), style = AuntieTheme.typography.bodySmall, color = c.textDim)
            Text(row.whenLine(zone), style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
            row.reason?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = c.textDim) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryButton(label = "Accept", onClick = { onDecide(AskDecision.ACCEPT) })
            GhostButton(label = "Decline", onClick = { onDecide(AskDecision.DECLINE) })
        }
    }
}

@Composable
private fun AskFact(label: String, value: String) {
    val c = AuntieTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.padding(bottom = 10.dp)) {
        Text(label.uppercase(), style = AuntieTheme.typography.labelSmall, color = c.textDim)
        Text(value, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
    }
}

/** #1577: the ask opened from its card, with the same Accept and Decline. */
@Composable
private fun VisitAskDetailDialog(row: VisitAsk, zone: TimeZone, onClose: () -> Unit, onDecide: (AskDecision) -> Unit) {
    val catalog = LocalServiceCatalog.current
    val kin = row.kinNames.filter { it.isNotBlank() }
    AuntieDialog(
        visible = true,
        title = row.detailTitle(),
        onDismiss = onClose,
        footer = {
            GhostButton(label = "Close", onClick = onClose)
            GhostButton(label = "Decline", onClick = { onDecide(AskDecision.DECLINE) })
            PrimaryButton(label = "Accept", onClick = { onDecide(AskDecision.ACCEPT) })
        },
    ) {
        AskFact("Household", row.householdLabel())
        AskFact("Service", row.serviceFact(catalog))
        AskFact("Kin", if (kin.isEmpty()) "Not on the request" else kin.joinToString(", "))
        when (row) {
            is VisitAsk.Cancel -> AskFact("Visit", askTimeLabel(row.ask.startTimeMs, zone))
            is VisitAsk.Reschedule -> {
                AskFact("Booked for", askTimeLabel(row.ask.currentStartTimeMs, zone))
                AskFact("Asked to move to", askTimeLabel(row.ask.proposedStartTimeMs, zone))
            }
        }
        AskFact("Reason given", row.reason ?: "None given")
        AskFact("Asked", askTimeLabel(row.requestedAtMs, zone))
    }
}

/**
 * The confirm step. Pessimistic: it stays open on "Working…" until the server
 * answers, and a refusal stays inside it in the server's own words, with
 * "Accept anyway" when a move met a busy block or another visit.
 */
@Composable
private fun VisitAskDecisionDialog(
    row: VisitAsk,
    decision: AskDecision,
    zone: TimeZone,
    onClose: () -> Unit,
    onAnswered: (String) -> Unit,
) {
    val c = AuntieTheme.colors
    val catalog = LocalServiceCatalog.current
    val scope = rememberReportingScope()
    var note by remember(row.key(), decision) { mutableStateOf("") }
    var busy by remember(row.key(), decision) { mutableStateOf(false) }
    var error by remember(row.key(), decision) { mutableStateOf<String?>(null) }
    var granted by remember(row.key(), decision) { mutableStateOf<Set<ScheduleOverride>>(emptySet()) }
    var retry by remember(row.key(), decision) { mutableStateOf<ScheduleOverride?>(null) }

    fun submit(overrides: Set<ScheduleOverride>) {
        if (busy) return
        busy = true
        error = null
        retry = null
        scope.launch {
            when (val answer = answerVisitAsk(row, decision, note, overrides)) {
                is VisitAskAnswer.Done -> { busy = false; onAnswered(answer.message) }
                is VisitAskAnswer.Refused -> {
                    busy = false
                    granted = overrides
                    error = answer.message
                    retry = answer.retry
                }
            }
        }
    }

    AuntieDialog(
        visible = true,
        title = row.decisionTitle(decision),
        onDismiss = { if (!busy) onClose() },
        footer = {
            GhostButton(label = "Never mind", onClick = onClose, enabled = !busy)
            PrimaryButton(
                label = if (busy) "Working…" else row.confirmLabel(decision),
                onClick = { submit(granted) },
                enabled = !busy,
                loading = busy,
            )
        },
    ) {
        Text(row.householdLabel(), style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
        Text(row.subject(catalog), style = AuntieTheme.typography.bodySmall, color = c.textDim)
        Text(row.decisionLine(decision, zone), style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
        MultilineField(
            value = note,
            onValueChange = { if (!busy) note = it.take(ASK_NOTE_MAX) },
            label = askNoteLabel(decision),
            minLines = 3,
            modifier = Modifier.fillMaxWidth(),
        )
        error?.let { message ->
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                title = "Not done",
                trailing = retry?.let { kind ->
                    { GhostButton(label = "Accept anyway", onClick = { submit(granted + kind) }, enabled = !busy) }
                },
            ) { Text(message, style = AuntieTheme.typography.bodySmall, color = c.textDim) }
        }
    }
}
