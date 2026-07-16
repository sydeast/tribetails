package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.AuntieDataSource
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.util.SortOption
import com.tribetails.auntieos.web.util.kinfolkSurnameSortKey
import com.tribetails.auntieos.web.util.sortedByOption
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.update

/**
 * Directory Kinfolk-tab state holder.
 *
 * Owns the Kinfolk stream plus the shared search query and sort option so the
 * list screen no longer duplicates filter/sort logic inline. The Kin tab reuses
 * [query] and [sort] for a consistent search/sort experience, but its data comes
 * from the screen's own `allKinStream()` collection because [AuntieDataSource]
 * (a shared, non-editable interface) does not expose a Kin stream here.
 */
data class DirectoryUiState(
    val allKinfolk: FirestoreResult<List<Kinfolk>> = FirestoreResult.Loading,
    val query: String = "",
    val sort: SortOption = SortOption.Default,
) {
    /** Search-filtered then sorted Kinfolk, ready to render. */
    val filteredSorted: List<Kinfolk>
        get() = when (val r = allKinfolk) {
            is FirestoreResult.Data ->
                r.value
                    .filter { it.matches(query) }
                    .sortedByOption(
                        option = sort,
                        // 03-directory item 3: order by surname (last name), not first.
                        name = { kinfolkSurnameSortKey(it.firstName, it.lastName, it.displayName) },
                        // Kinfolk has no createdAt/updatedAt yet; joinDate is the
                        // only recency signal on hand. Used for both recency axes
                        // until the schema grows real timestamps.
                        createdAt = { it.joinDate },
                        updatedAt = { it.joinDate },
                    )
            else -> emptyList()
        }

    /** True when the underlying stream returned an empty (not error) list. */
    val sourceIsEmpty: Boolean
        get() = (allKinfolk as? FirestoreResult.Data)?.value?.isEmpty() ?: false

    val isLoading: Boolean get() = allKinfolk == FirestoreResult.Loading
    val error: String? get() = (allKinfolk as? FirestoreResult.Error)?.message
}

/**
 * Phone search normalization: strip everything but digits so a bare-digit query
 * (e.g. last 4 of a number) matches a stored, formatted number like
 * "(512) 555-1234". Audit data-issue: raw substring match missed formatted
 * numbers the empty-state copy promised would match.
 */
private fun digitsOnly(s: String): String = s.filter { it.isDigit() }

private fun Kinfolk.matches(needle: String): Boolean {
    if (needle.isBlank()) return true
    val n = needle.trim().lowercase()
    val byText = displayName.lowercase().contains(n) || email.lowercase().contains(n)
    val digits = digitsOnly(needle)
    val byPhone = digits.isNotEmpty() && digitsOnly(phoneNumber).contains(digits)
    return byText || byPhone
}

class DirectoryViewModel(
    private val dataSource: AuntieDataSource,
    scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
) {
    private val _state = MutableStateFlow(DirectoryUiState())
    val state: StateFlow<DirectoryUiState> = _state.asStateFlow()

    init {
        dataSource.kinfolkStream()
            .onEach { result -> _state.update { it.copy(allKinfolk = result) } }
            .launchIn(scope)
    }

    fun search(query: String) {
        _state.update { it.copy(query = query) }
    }

    fun clearSearch() {
        _state.update { it.copy(query = "") }
    }

    fun setSort(option: SortOption) {
        _state.update { it.copy(sort = option) }
    }
}
