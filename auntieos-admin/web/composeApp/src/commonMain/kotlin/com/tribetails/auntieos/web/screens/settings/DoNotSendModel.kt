package com.tribetails.auntieos.web.screens.settings

import com.tribetails.auntieos.web.data.ClearSuppressionResult
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.Suppression
import com.tribetails.auntieos.web.data.SuppressionPage
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.datetime.toLocalDateTime
import kotlin.time.ExperimentalTime
import kotlin.time.Instant

/**
 * #1102: the Settings > Notifications "Do-not-send list" on the desktop console.
 * Twins: admin web `DoNotSendSection.tsx` and Android `DoNotSendViewModel`; the
 * words and the rules are the same.
 *
 * Pessimistic: a row changes only after the server confirms the clear. Clear
 * asks first ([DoNotSendUiState.pending]), inside the app, and the server
 * records who cleared it.
 *
 * Clear removes a BOUNCE, never an opt-out. A row that is both stays on the
 * list as an opt-out once its bounce is cleared; an opt-out only row is not
 * clearable.
 */
/** The two callables, so the model is testable without the network. */
interface MessageSuppressionSource {
    suspend fun list(reason: String, cursor: String?): WriteResult<SuppressionPage>
    suspend fun clear(recipient: String): WriteResult<ClearSuppressionResult>
}

class FirestoreMessageSuppressionSource(private val client: FirestoreClient = FirestoreClient()) : MessageSuppressionSource {
    override suspend fun list(reason: String, cursor: String?) = client.listMessageSuppressions(reason, cursor)
    override suspend fun clear(recipient: String) = client.clearMessageSuppression(recipient)
}

sealed interface DoNotSendLoad {
    data object Loading : DoNotSendLoad

    data class Failed(val message: String) : DoNotSendLoad

    data class Ready(val items: List<Suppression>, val nextCursor: String?) : DoNotSendLoad
}

data class DoNotSendUiState(
    val filter: String = "all",
    val load: DoNotSendLoad = DoNotSendLoad.Loading,
    val loadingMore: Boolean = false,
    val pending: Suppression? = null,
    val clearing: Boolean = false,
    val error: String? = null,
    val note: String? = null,
)

val DO_NOT_SEND_FILTERS = listOf("all", "hard_bounce", "opt_out")

fun doNotSendFilterLabel(key: String): String = when (key) {
    "hard_bounce" -> "Hard bounces"
    "opt_out" -> "Opt-outs"
    else -> "All"
}

fun doNotSendReasonLabel(row: Suppression): String =
    if (row.reason == "hard_bounce") "Hard bounce" else "Opted out"

fun doNotSendSourceLabel(row: Suppression): String =
    if (row.source == "smtp2go") "smtp2go" else "Admin"

/** Local `YYYY-MM-DD HH:mm` for [ms] in the given zone, matching the web and Android lists. */
@OptIn(ExperimentalTime::class)
fun doNotSendWhenLabel(ms: Long, zone: kotlinx.datetime.TimeZone = kotlinx.datetime.TimeZone.currentSystemDefault()): String {
    if (ms <= 0L) return "(no time)"
    val t = Instant.fromEpochMilliseconds(ms).toLocalDateTime(zone)

    fun two(n: Int) = n.toString().padStart(2, '0')
    return "${t.year}-${two(t.month.ordinal + 1)}-${two(t.day)} ${two(t.hour)}:${two(t.minute)}"
}

/** The meta line under the address: reason, an opt-out that also holds, source, when. */
fun doNotSendMetaLine(row: Suppression, zone: kotlinx.datetime.TimeZone = kotlinx.datetime.TimeZone.currentSystemDefault()): String =
    listOfNotNull(
        doNotSendReasonLabel(row),
        "Also opted out".takeIf { row.reason == "hard_bounce" && row.optedOut },
        doNotSendSourceLabel(row),
        doNotSendWhenLabel(row.suppressedAtMs, zone),
    ).joinToString(", ")

/** The confirmation body, word for word the web and Android text. */
fun doNotSendConfirmText(row: Suppression): String {
    val optOut = if (row.optedOut) " Their opt-out stays." else ""
    return "${row.recipient} comes off the bounce list and Auntie can mail it again.$optOut " +
        "Your name is recorded against the change."
}

class DoNotSendModel(private val source: MessageSuppressionSource = FirestoreMessageSuppressionSource()) {
    private val _state = MutableStateFlow(DoNotSendUiState())
    val state: StateFlow<DoNotSendUiState> = _state.asStateFlow()
    suspend fun load() {
        val filter = _state.value.filter
        _state.value = _state.value.copy(load = DoNotSendLoad.Loading)
        val r = source.list(filter, null)
        // A slower answer for a filter the operator already left must not overwrite the newer one.
        if (_state.value.filter != filter) return
        _state.value = _state.value.copy(
            load = when (r) {
                is WriteResult.Ok -> DoNotSendLoad.Ready(r.value.items, r.value.nextCursor)
                is WriteResult.Err -> DoNotSendLoad.Failed("Couldn't read the do-not-send list: ${r.message.ifBlank { "load failed" }}")
            },
        )
    }

    /** Switches the filter and returns true when a reload is needed. */
    fun setFilter(filter: String): Boolean {
        if (filter == _state.value.filter) return false
        _state.value = _state.value.copy(filter = filter, error = null, note = null)
        return true
    }
    suspend fun loadMore() {
        val s = _state.value
        val ready = s.load as? DoNotSendLoad.Ready ?: return
        val cursor = ready.nextCursor ?: return
        if (s.loadingMore) return
        _state.value = s.copy(loadingMore = true, error = null)
        val r = source.list(s.filter, cursor)
        val cur = _state.value
        if (cur.filter != s.filter) {
            _state.value = cur.copy(loadingMore = false)
            return
        }
        _state.value = when (r) {
            is WriteResult.Ok -> {
                val now = cur.load as? DoNotSendLoad.Ready
                cur.copy(
                    load = if (now != null) DoNotSendLoad.Ready(now.items + r.value.items, r.value.nextCursor) else cur.load,
                    loadingMore = false,
                )
            }
            is WriteResult.Err -> cur.copy(loadingMore = false, error = r.message.ifBlank { "Load failed" })
        }
    }

    /** Only a bounce can be cleared. An opt-out only row is ignored. */
    fun askClear(row: Suppression) {
        if (_state.value.clearing || !row.clearable) return
        _state.value = _state.value.copy(pending = row)
    }

    fun cancelClear() {
        if (_state.value.clearing) return
        _state.value = _state.value.copy(pending = null)
    }
    suspend fun confirmClear() {
        val s = _state.value
        val row = s.pending ?: return
        if (s.clearing) return
        _state.value = s.copy(clearing = true, error = null, note = null)
        val r = source.clear(row.recipient)
        val cur = _state.value
        _state.value = when (r) {
            is WriteResult.Ok -> {
                val ready = cur.load as? DoNotSendLoad.Ready
                cur.copy(
                    load = ready?.copy(items = afterClear(ready.items, row, r.value)) ?: cur.load,
                    clearing = false,
                    pending = null,
                    note = clearedNote(row, r.value),
                )
            }
            is WriteResult.Err -> cur.copy(
                clearing = false,
                pending = null,
                error = r.message.takeIf { it.isNotBlank() } ?: "The clear failed.",
            )
        }
    }

    fun dismissMessages() {
        _state.value = _state.value.copy(error = null, note = null)
    }

    companion object {
        /** The rows after a clear: a bounce that was also an opt-out stays as an opt-out; any other row goes. */
        fun afterClear(items: List<Suppression>, row: Suppression, res: ClearSuppressionResult): List<Suppression> =
            if (res.optOutKept) {
                items.map {
                    if (it.recipient == row.recipient) {
                        it.copy(reason = "opt_out", source = "admin", eventId = null, optedOut = true)
                    } else {
                        it
                    }
                }
            } else {
                items.filter { it.recipient != row.recipient }
            }

        fun clearedNote(row: Suppression, res: ClearSuppressionResult): String {
            val who = res.recipientRedacted.ifBlank { row.recipientRedacted }
            return if (res.optOutKept) "Cleared the bounce on $who. The opt-out stays." else "Cleared $who. It can be mailed again."
        }
    }
}
