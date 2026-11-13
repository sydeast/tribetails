package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.observability.reportingExceptionHandler
import com.tribetails.auntieos.web.observability.runCatchingCancellable
import kotlin.time.ExperimentalTime
import kotlin.time.Instant

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
            is FirestoreResult.Data -> {
                val rows = r.value.filter { it.matches(query) }
                // 03-directory item 3: order by surname (last name), not first.
                val surname = { kf: Kinfolk -> kinfolkSurnameSortKey(kf.firstName, kf.lastName, kf.displayName) }
                if (sort == SortOption.RecentlyCreated) {
                    sortRecentlyCreated(rows, surname)
                } else {
                    rows.sortedByOption(
                        option = sort,
                        name = surname,
                        createdAt = { "" },
                        updatedAt = { it.joinDate },
                    )
                }
            }
            else -> emptyList()
        }

    /** True when the underlying stream returned an empty (not error) list. */
    val sourceIsEmpty: Boolean
        get() = (allKinfolk as? FirestoreResult.Data)?.value?.isEmpty() ?: false

    val isLoading: Boolean get() = allKinfolk == FirestoreResult.Loading
    val error: String? get() = (allKinfolk as? FirestoreResult.Error)?.message
}

// ── Recently Created (#1953) ────────────────────────────────────────────────

/** Which date places a household under Recently Created; declared in rank order, highest first. */
internal enum class CreatedTier { Created, Joined, None }

internal data class KinfolkCreatedAt(val tier: CreatedTier, val millis: Long)

private val ISO_DAY = Regex("""^\d{4}-\d{2}-\d{2}$""")
private val ISO_INSTANT = Regex("""^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$""")

/** Epoch millis of an ISO day (UTC midnight) or ISO instant, else null. Free text is never guessed at. */
@OptIn(ExperimentalTime::class)
private fun isoMillis(raw: String): Long? {
    val s = raw.trim()
    val iso = when {
        ISO_DAY.matches(s) -> "${s}T00:00:00Z"
        ISO_INSTANT.matches(s) -> s
        else -> return null
    }
    return runCatchingCancellable { Instant.parse(iso).toEpochMilliseconds() }.getOrNull()
}

/**
 * #1953, the same rule as the web admin's `kinfolkCreatedMillis` and Android's
 * `kinfolkCreatedAt`. Highest tier first:
 *  - Created: the record's own `createdAt`, stamped by the createKinfolk
 *    callable, so every stamped household is newer than every unstamped one. A
 *    `createdAtSource` of "import" is only the import date and is skipped.
 *  - Joined: a household from before that stamp is placed by its join date,
 *    when that reads as a date.
 *  - None: no readable date. Sorts last, A to Z; never given a made-up date.
 * The Firestore document create time is never used: after a data reload it is
 * the import date.
 */
internal fun kinfolkCreatedAt(kf: Kinfolk): KinfolkCreatedAt {
    if (kf.createdAtSource.trim() != "import") {
        isoMillis(kf.createdAt)?.let { return KinfolkCreatedAt(CreatedTier.Created, it) }
    }
    isoMillis(kf.joinDate)?.let { return KinfolkCreatedAt(CreatedTier.Joined, it) }
    return KinfolkCreatedAt(CreatedTier.None, 0L)
}

private fun sortRecentlyCreated(rows: List<Kinfolk>, surname: (Kinfolk) -> String): List<Kinfolk> =
    rows.map { Triple(it, kinfolkCreatedAt(it), surname(it)) }
        .sortedWith(
            compareBy<Triple<Kinfolk, KinfolkCreatedAt, String>> { it.second.tier.ordinal }
                .thenByDescending { it.second.millis }
                .thenBy { it.third },
        )
        .map { it.first }

// ── Search (#1952) ──────────────────────────────────────────────────────────

/** The fewest digits a search must hold before it is compared with phones. Three covers an area code. */
internal const val MIN_PHONE_SEARCH_DIGITS = 3

/** Only digits and the marks people type in a phone number: space ( ) + - . */
private val PHONE_SHAPED = Regex("""^[\d\s()+.\-]+$""")

private fun digitsOnly(s: String): String = s.filter { it.isDigit() }

/** A US number with its leading country code 1 reads as the ten digits after it. */
private fun withoutCountryCode(digits: String): String =
    if (digits.length == 11 && digits.startsWith('1')) digits.drop(1) else digits

/**
 * Name or email substring, or, when the text reads as a phone number (digits
 * and phone marks only, at least [MIN_PHONE_SEARCH_DIGITS] digits), a
 * digits-to-digits phone match, so "805-555-0188" finds a stored
 * "(805) 555-0188" (#1952). Text with a letter in it is never compared with
 * phones: "zzzz8" used to list every household with an 8 in its number. The
 * same rule as the web admin's `matchesKinfolk` and Android's
 * `matchesKinfolkSearch`.
 */
private fun Kinfolk.matches(needle: String): Boolean {
    val q = needle.trim()
    if (q.isEmpty()) return true
    val n = q.lowercase()
    if (displayName.lowercase().contains(n) || email.lowercase().contains(n)) return true
    if (!PHONE_SHAPED.matches(q)) return false
    val digits = withoutCountryCode(digitsOnly(q))
    if (digits.length < MIN_PHONE_SEARCH_DIGITS) return false
    return withoutCountryCode(digitsOnly(phoneNumber)).contains(digits)
}

class DirectoryViewModel(
    private val dataSource: AuntieDataSource,
    scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default + reportingExceptionHandler("vm:Directory")),
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
