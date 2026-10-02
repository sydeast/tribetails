package com.tribetails.auntieos.ui.admin

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.data.repository.MessageSuppressionRepository
import com.tribetails.auntieos.data.repository.MessageSuppressionRepository.ClearResult
import com.tribetails.auntieos.data.repository.MessageSuppressionRepository.Suppression
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * #1083: the Settings > Notifications "Do-not-send list" panel on Android. The
 * web twin is `auntieos-admin/src/screens/settings/DoNotSendSection.tsx`.
 *
 * Pessimistic (D-2026-09-12-SLOW-WAIT): a row changes only after the server
 * confirms the clear. Clear asks first (`pending`), in the page, and the server
 * records who cleared it.
 *
 * Clear removes a BOUNCE, never an opt-out. A row that is both stays on the list
 * as an opt-out once its bounce is cleared; an opt-out only row is not clearable.
 */
class DoNotSendViewModel(
    private val repository: MessageSuppressionRepository = MessageSuppressionRepository(),
) : ViewModel() {

    sealed interface Load {
        data object Loading : Load
        data class Failed(val message: String) : Load
        data class Ready(val items: List<Suppression>, val nextCursor: String?) : Load
    }

    data class UiState(
        val filter: String = "all",
        val load: Load = Load.Loading,
        val loadingMore: Boolean = false,
        val pending: Suppression? = null,
        val clearing: Boolean = false,
        val error: String? = null,
        val note: String? = null,
    )

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    init {
        load()
    }

    fun load() {
        _state.value = _state.value.copy(load = Load.Loading)
        val filter = _state.value.filter
        viewModelScope.launch {
            repository.list(filter)
                .onSuccess { page ->
                    if (_state.value.filter == filter) {
                        _state.value = _state.value.copy(load = Load.Ready(page.items, page.nextCursor))
                    }
                }
                .onFailure { e ->
                    if (_state.value.filter == filter) {
                        _state.value = _state.value.copy(
                            load = Load.Failed("Couldn't read the do-not-send list: ${e.message ?: "load failed"}"),
                        )
                    }
                }
        }
    }

    fun setFilter(filter: String) {
        if (filter == _state.value.filter) return
        _state.value = _state.value.copy(filter = filter, error = null, note = null)
        load()
    }

    fun loadMore() {
        val s = _state.value
        val ready = s.load as? Load.Ready ?: return
        val cursor = ready.nextCursor ?: return
        if (s.loadingMore) return
        _state.value = s.copy(loadingMore = true, error = null)
        viewModelScope.launch {
            repository.list(s.filter, cursor)
                .onSuccess { page ->
                    val cur = _state.value.load as? Load.Ready
                    _state.value = _state.value.copy(
                        load = if (cur != null) Load.Ready(cur.items + page.items, page.nextCursor) else _state.value.load,
                        loadingMore = false,
                    )
                }
                .onFailure { e ->
                    _state.value = _state.value.copy(loadingMore = false, error = e.message ?: "Load failed")
                }
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

    fun confirmClear() {
        val s = _state.value
        val row = s.pending ?: return
        if (s.clearing) return
        _state.value = s.copy(clearing = true, error = null, note = null)
        viewModelScope.launch {
            repository.clear(row.recipient)
                .onSuccess { res ->
                    val cur = _state.value.load as? Load.Ready
                    _state.value = _state.value.copy(
                        load = cur?.copy(items = afterClear(cur.items, row, res)) ?: _state.value.load,
                        clearing = false,
                        pending = null,
                        note = clearedNote(row, res),
                    )
                }
                .onFailure { e ->
                    _state.value = _state.value.copy(
                        clearing = false,
                        pending = null,
                        error = e.message?.takeIf { it.isNotBlank() } ?: "The clear failed.",
                    )
                }
        }
    }

    fun dismissMessages() {
        _state.value = _state.value.copy(error = null, note = null)
    }

    private fun afterClear(items: List<Suppression>, row: Suppression, res: ClearResult): List<Suppression> =
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

    private fun clearedNote(row: Suppression, res: ClearResult): String {
        val who = res.recipientRedacted.ifBlank { row.recipientRedacted }
        return if (res.optOutKept) "Cleared the bounce on $who. The opt-out stays." else "Cleared $who. It can be mailed again."
    }
}
