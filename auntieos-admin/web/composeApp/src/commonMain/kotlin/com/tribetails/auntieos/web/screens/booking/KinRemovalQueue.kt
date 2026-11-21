@file:OptIn(kotlin.time.ExperimentalTime::class)

package com.tribetails.auntieos.web.screens.booking

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
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
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.CircleCheckBig
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.web.data.KIN_REMOVAL_NOTE_MAX
import com.tribetails.auntieos.web.data.KinRemovalAnswer
import com.tribetails.auntieos.web.data.KinRemovalDecision
import com.tribetails.auntieos.web.data.KinRemovalRequest
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.listKinRemovalRequests
import com.tribetails.auntieos.web.data.resolveKinRemovalRequest
import com.tribetails.auntieos.web.observability.rememberReportingScope
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.AuntieSpinner
import com.tribetails.auntieos.web.ui.components.DenPanel
import com.tribetails.auntieos.web.ui.components.EmptyHint
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.LoadErrorBanner
import com.tribetails.auntieos.web.ui.components.MultilineField
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import kotlin.time.Instant
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime

/**
 * #2121: a Kinfolk's request to remove a Kin that has history (#1408) had no
 * place on the console. Admin web lists the waiting requests on Bookings with
 * Archive and Decline, and Android on the schedule; here "Open" on the "Kinfolk
 * asked to remove a Kin" notice landed on the household profile, where the
 * request cannot be answered.
 *
 * The queue reads `listKinRemovalRequests` and answers through
 * `resolveKinRemovalRequest`, the callables admin web calls. The words are web's
 * (`components/KinRemovalRequests.tsx`). Archiving is the owner's; a sandbox
 * test admin is refused both callables, so nothing is read for one.
 */

/** Test tag on each removal request's card. */
const val KIN_REMOVAL_ROW_TAG = "kin-removal-row"
/** Test tag on the card a notice opened Bookings for. */
const val KIN_REMOVAL_FOCUS_TAG = "kin-removal-focus"

/** Read again this often, the same floor as the visit request queues. */
const val KIN_REMOVAL_REFRESH_MS = 60_000L
/** After a failed read, the next try comes this soon. */
const val KIN_REMOVAL_RETRY_MS = 10_000L

private val REMOVAL_MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/** "Nov 2, 2026" on the business calendar, or null when the request carries no time. */
fun removalDateLabel(ms: Long?, zone: TimeZone): String? {
    if (ms == null) return null
    val d = Instant.fromEpochMilliseconds(ms).toLocalDateTime(zone)
    return "${REMOVAL_MONTHS[d.month.ordinal]} ${d.day}, ${d.year}"
}

/** The Kin, by name. */
fun KinRemovalRequest.kinLabel(): String = kinName ?: "This Kin"

/** One line: who asked, when. */
fun KinRemovalRequest.requestedLine(zone: TimeZone): String {
    val date = removalDateLabel(requestedAtMs, zone)
    return if (date != null) "The household asked on $date to remove ${kinLabel()} from their profile."
    else "The household asked to remove ${kinLabel()} from their profile."
}

/** What the answer did, from what the server says it did. */
fun kinRemovalResolvedMessage(answer: KinRemovalAnswer): String {
    val name = answer.kinName ?: "The Kin"
    val told = if (answer.householdNotified) "The household has your answer."
    else "The message to the household did not go out, so tell them another way."
    return if (answer.decision == KinRemovalDecision.ARCHIVE) "$name is archived. $told"
    else "Declined. $name stays on the profile. $told"
}

fun KinRemovalRequest.decisionTitle(decision: KinRemovalDecision): String =
    if (decision == KinRemovalDecision.ARCHIVE) "Archive ${kinLabel()}" else "Keep ${kinLabel()}"

fun KinRemovalRequest.decisionLine(decision: KinRemovalDecision): String =
    if (decision == KinRemovalDecision.ARCHIVE)
        "${kinLabel()} comes off the household's profile. Visits, invoices and KinTales are kept, and the household will be told."
    else "${kinLabel()} stays on the household's profile. The household will be told."

fun kinRemovalConfirmLabel(decision: KinRemovalDecision): String =
    if (decision == KinRemovalDecision.ARCHIVE) "Archive it" else "Send the decline"

/** Said when the notice's request is no longer waiting. */
const val KIN_REMOVAL_ANSWERED_TITLE = "Kin removal request"
const val KIN_REMOVAL_ANSWERED_BODY = "That request has already been answered."

/** What the console knows about the removal queue. */
@Stable
class KinRemovalQueueState {
    /** Null until the first answer. */
    var requests: List<KinRemovalRequest>? by mutableStateOf(null)
        internal set
    var error: String? by mutableStateOf(null)
        internal set
    var reading: Boolean by mutableStateOf(false)
        internal set
    var generation: Int by mutableStateOf(0)
        private set
    /** The last answer's sentence, kept until dismissed. */
    var outcome: String? by mutableStateOf(null)
    private val answered = mutableStateMapOf<String, Boolean>()

    val rows: List<KinRemovalRequest> get() = requests.orEmpty().filter { answered[it.id] != true }

    /** Answered on this screen, so a notice's request that left the queue here is not "answered before". */
    fun answeredHere(id: String): Boolean = answered[id] == true

    fun retry() { generation++ }

    fun markAnswered(request: KinRemovalRequest, message: String) {
        answered[request.id] = true
        outcome = message
    }
}

/** Reads the queue once. A failed read keeps the rows it last read and says so. */
suspend fun readKinRemovalRequests(
    state: KinRemovalQueueState,
    list: suspend () -> WriteResult<List<KinRemovalRequest>> = { listKinRemovalRequests() },
) {
    state.reading = true
    when (val r = list()) {
        is WriteResult.Ok -> { state.requests = r.value; state.error = null }
        is WriteResult.Err -> state.error = r.message.ifBlank { "the read did not land" }
    }
    state.reading = false
}

/** The queue, read now and every [KIN_REMOVAL_REFRESH_MS]. Nothing is read when [enabled] is false. */
@Composable
fun rememberKinRemovalQueue(enabled: Boolean, refreshMs: Long = KIN_REMOVAL_REFRESH_MS): KinRemovalQueueState {
    val state = remember { KinRemovalQueueState() }
    LaunchedEffect(enabled, state.generation) {
        if (!enabled) return@LaunchedEffect
        while (true) {
            readKinRemovalRequests(state)
            // A failed read tries again soon, as the Retry tip says; a good one waits the floor.
            delay(if (state.error != null) KIN_REMOVAL_RETRY_MS else refreshMs)
        }
    }
    return state
}

/**
 * The Kin removal requests panel on Bookings. Says so while it reads, says so
 * when the read failed (with Retry), and draws nothing when nothing is waiting,
 * unless a notice opened a request that is no longer waiting.
 * [focusRequestId] is that notice's request: its card is marked.
 * [householdName] names the household a request belongs to, when the directory
 * holds it.
 */
@Composable
fun KinRemovalRequestsPanel(
    state: KinRemovalQueueState,
    zone: TimeZone,
    focusRequestId: String?,
    onFocusDismissed: () -> Unit,
    householdName: (kinfolkId: String) -> String?,
) {
    val c = AuntieTheme.colors
    var sheet by remember { mutableStateOf<Pair<KinRemovalRequest, KinRemovalDecision>?>(null) }
    val loaded = state.requests != null
    val rows = state.rows
    val answeredBefore = focusRequestId != null && loaded && !state.answeredHere(focusRequestId) &&
        state.requests.orEmpty().none { it.id == focusRequestId }

    if (!loaded && state.error == null) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AuntieSpinner(modifier = Modifier.size(14.dp))
            Text("Checking for Kin removal requests…", style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
        return
    }
    if (!loaded) {
        LoadErrorBanner(
            title = "Couldn't load Kin removal requests",
            message = state.error.orEmpty(),
            onRetry = { state.retry() },
            retrying = state.reading,
        )
        return
    }
    if (rows.isEmpty() && state.outcome == null && !answeredBefore && state.error == null) return

    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        if (answeredBefore) {
            AuntieBanner(
                tone = AuntieBannerTone.Info,
                title = KIN_REMOVAL_ANSWERED_TITLE,
                onDismiss = onFocusDismissed,
            ) { Text(KIN_REMOVAL_ANSWERED_BODY, style = AuntieTheme.typography.bodySmall, color = c.textDim) }
        }
        state.outcome?.let { said ->
            AuntieBanner(
                tone = AuntieBannerTone.Success,
                title = "Done",
                icon = Lucide.CircleCheckBig,
                onDismiss = { state.outcome = null },
            ) { Text(said, style = AuntieTheme.typography.bodySmall, color = c.textDim) }
        }
        state.error?.let {
            LoadErrorBanner(
                title = "Couldn't refresh Kin removal requests",
                message = "$it Showing what loaded earlier, which may be out of date.",
                onRetry = { state.retry() },
                retrying = state.reading,
            )
        }
        if (rows.isNotEmpty()) {
            DenPanel(
                title = "Kin removal requests",
                subtitle = "Households asked to remove a Kin that has history on file.",
                trailing = { Text("${rows.size} waiting", style = AuntieTheme.typography.mono, color = c.textDim) },
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    rows.forEach { r ->
                        KinRemovalCard(
                            request = r,
                            zone = zone,
                            household = householdName(r.kinfolkId),
                            focused = r.id == focusRequestId,
                            onDecide = { decision -> sheet = r to decision },
                        )
                    }
                }
            }
        }
    }

    sheet?.let { (request, decision) ->
        KinRemovalDecisionDialog(
            request = request,
            decision = decision,
            onClose = { sheet = null },
            onAnswered = { message ->
                sheet = null
                state.markAnswered(request, message)
            },
        )
    }
}

@Composable
private fun KinRemovalCard(
    request: KinRemovalRequest,
    zone: TimeZone,
    household: String?,
    focused: Boolean,
    onDecide: (KinRemovalDecision) -> Unit,
) {
    val c = AuntieTheme.colors
    val viewRequester = remember { BringIntoViewRequester() }
    if (focused) {
        LaunchedEffect(request.id) {
            withFrameNanos { }
            viewRequester.bringIntoView()
        }
    }
    // The mark sits on its own wrapper: one node carries one test tag.
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (focused) Modifier
                    .testTag(KIN_REMOVAL_FOCUS_TAG)
                    .semantics { stateDescription = "Opened from the notice" }
                    .border(2.dp, c.accent, RoundedCornerShape(10.dp))
                    .bringIntoViewRequester(viewRequester)
                else Modifier,
            ),
    ) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .testTag(KIN_REMOVAL_ROW_TAG)
            .clip(RoundedCornerShape(10.dp))
            .background(c.surface)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("REMOVE KIN", style = AuntieTheme.typography.labelSmall, color = c.warning)
            Text(request.kinLabel(), style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
        }
        household?.takeIf { it.isNotBlank() }?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = c.textDim) }
        Text(request.requestedLine(zone), style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
        request.reason?.let { Text(it, style = AuntieTheme.typography.bodySmall, color = c.textDim) }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PrimaryButton(label = "Archive", onClick = { onDecide(KinRemovalDecision.ARCHIVE) })
            GhostButton(label = "Decline", onClick = { onDecide(KinRemovalDecision.DECLINE) })
        }
    }
    }
}

/**
 * Archive or decline, with an optional note for the household. Pessimistic: it
 * stays open on "Working…" until the server answers, and a refusal stays inside
 * it in the server's own words.
 */
@Composable
private fun KinRemovalDecisionDialog(
    request: KinRemovalRequest,
    decision: KinRemovalDecision,
    onClose: () -> Unit,
    onAnswered: (String) -> Unit,
) {
    val c = AuntieTheme.colors
    val scope = rememberReportingScope()
    var note by remember(request.id, decision) { mutableStateOf("") }
    var busy by remember(request.id, decision) { mutableStateOf(false) }
    var error by remember(request.id, decision) { mutableStateOf<String?>(null) }

    fun submit() {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            when (val r = resolveKinRemovalRequest(request.id, decision, note)) {
                is WriteResult.Ok -> { busy = false; onAnswered(kinRemovalResolvedMessage(r.value)) }
                is WriteResult.Err -> { busy = false; error = r.message }
            }
        }
    }

    AuntieDialog(
        visible = true,
        title = request.decisionTitle(decision),
        onDismiss = { if (!busy) onClose() },
        footer = {
            GhostButton(label = "Never mind", onClick = onClose, enabled = !busy)
            PrimaryButton(
                label = if (busy) "Working…" else kinRemovalConfirmLabel(decision),
                onClick = { submit() },
                enabled = !busy,
                loading = busy,
            )
        },
    ) {
        Text(request.decisionLine(decision), style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
        MultilineField(
            value = note,
            onValueChange = { if (!busy) note = it.take(KIN_REMOVAL_NOTE_MAX) },
            label = "Note for the household (optional)",
            minLines = 3,
            modifier = Modifier.fillMaxWidth(),
        )
        error?.let { message ->
            AuntieBanner(tone = AuntieBannerTone.Error, title = "Not done") {
                Text(message, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        }
    }
}

/** For a sandbox test admin, who is refused both removal callables. */
@Composable
fun KinRemovalSandboxHint() {
    EmptyHint("Kin removal requests aren't available in the sandbox.")
}
