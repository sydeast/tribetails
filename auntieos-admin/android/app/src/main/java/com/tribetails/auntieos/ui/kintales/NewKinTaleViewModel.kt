package com.tribetails.auntieos.ui.kintales

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.repository.KinCareRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * What the household profile's "New KinTale" needs and the composer cannot
 * supply: WHICH VISIT this tale recaps.
 *
 * [KinTaleReportViewModel] is already the composer, and it is keyed by a session
 * (`kintale/{sessionId}`) because a KinTale is always the write-up of one visit.
 * Every existing way into it - the Auntie Time card, the KinTale log, a
 * notification - arrives holding that session id. The profile hero does not: it
 * knows WHOSE tale this is and nothing about which visit. That gap is the only
 * reason "New KinTale" had nowhere to go on Android, and this picker is the gap.
 *
 * SCOPED, NOT GLOBAL, when it is opened from a profile. [load] takes the
 * household and asks Firestore for that household's sessions
 * ([KinCareRepository.getKinCareSessionsForKinfolk]) rather than pulling every
 * session and filtering on the phone: the operator opened one household's
 * profile, and landing them in a list of every household's visits to find their
 * own is the thing the mock's hero button exists to avoid. Opened with no
 * household (the KinTale log's own "New"), it falls back to the whole list, which
 * is what that entry point has always meant.
 *
 * ELIGIBILITY IS [isKinTaleEligibleSession], the same DEPARTED-or-COMPLETED
 * positive membership the React composer applies, and applied here rather than in
 * the query: `status` is free text on this collection and a `whereIn` would need
 * a composite index per household, for a filter over a list that is already
 * bounded by one household.
 */
data class NewKinTaleUiState(
    val isLoading: Boolean = true,
    /** Eligible sessions, most recent visit first. */
    val sessions: List<KinCareSession> = emptyList(),
    /** Non-null when the read failed. The screen offers a retry rather than an empty list. */
    val error: String? = null,
    /** Blank when this picker was opened unscoped, from the KinTale log rather than a profile. */
    val kinfolkId: String = "",
) {
    /**
     * The household these visits belong to, when they all belong to one.
     *
     * Read off the sessions rather than passed down a route argument: the profile
     * already proved the household exists, and a display name threaded through a
     * nav route is a second copy that can disagree with the record.
     */
    val householdName: String
        get() = sessions.firstOrNull()?.kinfolkName.orEmpty()

    /** True only once a successful read came back with nothing eligible in it. */
    val isEmpty: Boolean get() = !isLoading && error == null && sessions.isEmpty()
}

class NewKinTaleViewModel(
    private val kinCareRepository: KinCareRepository = AuntieOSApp.instance.kinCareRepository,
) : ViewModel() {

    private val _uiState = MutableStateFlow(NewKinTaleUiState())
    val uiState: StateFlow<NewKinTaleUiState> = _uiState.asStateFlow()

    private var loadedKinfolkId: String = ""

    /**
     * Load the sessions this picker may offer.
     *
     * [kinfolkId] blank means "every household", the unscoped entry point. A
     * FAILED READ IS NOT AN EMPTY LIST: the two look identical on screen and mean
     * opposite things ("nothing to write up" versus "we could not ask"), so the
     * failure is kept as [NewKinTaleUiState.error] and the screen offers Retry.
     */
    fun load(kinfolkId: String) {
        loadedKinfolkId = kinfolkId
        viewModelScope.launch {
            _uiState.value = NewKinTaleUiState(isLoading = true, kinfolkId = kinfolkId)
            val read = if (kinfolkId.isBlank()) {
                kinCareRepository.getKinCareSessions()
            } else {
                kinCareRepository.getKinCareSessionsForKinfolk(kinfolkId)
            }
            read.fold(
                onSuccess = { all ->
                    _uiState.value = NewKinTaleUiState(
                        isLoading = false,
                        sessions = eligibleKinTaleSessions(all),
                        kinfolkId = kinfolkId,
                    )
                },
                onFailure = { e ->
                    _uiState.value = NewKinTaleUiState(
                        isLoading = false,
                        error = "Couldn't load visits: ${e.message ?: "unknown error"}",
                        kinfolkId = kinfolkId,
                    )
                },
            )
        }
    }

    /** Re-run the last [load]. The read that failed was usually transient. */
    fun retry() = load(loadedKinfolkId)
}

/**
 * The eligible visits out of [all], most recent first.
 *
 * Pure and top-level so the filter and the ordering are testable without a
 * ViewModel or a Firestore double.
 *
 * ORDERED BY [KinCareSession.startTime] DESCENDING, string-compared: these are
 * ISO-8601 instants, which sort lexicographically in chronological order, and the
 * visit the operator is most likely writing up is the one that just ended. A
 * session with a blank `startTime` sorts LAST rather than first, so a broken date
 * never takes the top of the list.
 */
internal fun eligibleKinTaleSessions(all: List<KinCareSession>): List<KinCareSession> =
    all.filter { isKinTaleEligibleSession(it.status) }
        .sortedWith(
            compareBy<KinCareSession> { it.startTime.isBlank() }
                .thenByDescending { it.startTime },
        )
