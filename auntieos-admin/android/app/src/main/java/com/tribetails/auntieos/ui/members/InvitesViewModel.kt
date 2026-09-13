package com.tribetails.auntieos.ui.members

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.data.repository.MembersRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Invites, across every household. The Android mirror of
 * `auntieos-admin/src/screens/Invites.tsx`; the two move together.
 *
 * WHAT WAS MISSING. [HouseholdMembersViewModel] beside this one is always about
 * ONE household, because `listInvites` takes a `familyId`. So the operator's
 * real question, "who did we invite who never came in", could only be
 * answered by opening every household by hand. `listAllInvites` is that
 * question, and this is its screen state.
 *
 * IT IS A READ, AND IT STAYS ONE. Per the invite ruling (CLAUDE.md, "WHO
 * INVITES WHOM", 2026-08-04) the admin's only invite is inviting a PRIMARY to
 * the portal, and both callables that do it are household-scoped; the PRIMARY
 * invites the secondary from MyTribe. There is no mint here, no revoke, and no
 * permission write. They were not left for later: an admin-WIDE surface has no
 * household to act on. Every action lives one tap away on
 * [HouseholdMembersScreen].
 *
 * FAIL LOUD, AND DO NOT DEMOTE WHAT WAS READ. [InvitesUiState.loaded] is what
 * earns the empty state, and a failed RELOAD leaves it alone: an unreadable
 * list must never render as an empty one, and a list that was read once does
 * not become unknown because the next read failed.
 */
enum class InviteFilter(val label: String) {
    OUTSTANDING("Outstanding"),
    ACCEPTED("Accepted"),
    REVOKED("Revoked"),
    ALL("All"),
}

/**
 * The statuses each filter admits, or null for "everything".
 *
 * OUTSTANDING answers "who never accepted", so an EXPIRED invite belongs in it:
 * that is still somebody who never came in, and it is the row most likely to
 * need a second send. REVOKED does not: that one was a decision already taken.
 */
private fun statusesFor(filter: InviteFilter): Set<MembersRepository.InviteStatus>? = when (filter) {
    InviteFilter.OUTSTANDING -> setOf(
        MembersRepository.InviteStatus.PENDING,
        MembersRepository.InviteStatus.EMAIL_SENT,
        MembersRepository.InviteStatus.EXPIRED,
    )
    InviteFilter.ACCEPTED -> setOf(MembersRepository.InviteStatus.ACCEPTED)
    InviteFilter.REVOKED -> setOf(MembersRepository.InviteStatus.REVOKED)
    InviteFilter.ALL -> null
}

/**
 * Rows matching one filter, in the order the server sent them (newest first).
 *
 * `effectiveStatus`, NEVER `status`. `expireStaleInvites` sweeps at 02:00, so a
 * lapsed invite still READS as EMAIL_SENT in Firestore for up to a day; the
 * server reconciles that at read time and this obeys it. Filtering on the raw
 * status would file a dead invite under Pending and send someone chasing it.
 */
internal fun filterInvites(
    rows: List<MembersRepository.AdminInvite>,
    filter: InviteFilter,
): List<MembersRepository.AdminInvite> {
    val wanted = statusesFor(filter) ?: return rows
    return rows.filter { it.invite.effectiveStatus in wanted }
}

data class InviteSection(
    val heading: String,
    /** The mock's `.ct`: the raw status codes the section collects, joined with a slash. */
    val statusNote: String,
    val rows: List<MembersRepository.AdminInvite>,
)

/**
 * Sections in a FIXED order, empty ones included, so a section that empties out
 * between reads cannot shuffle the ones below it. The order is the mock's
 * (`auntieos-invites-2026-05-27.html`: Pending, Accepted, Expired, Revoked),
 * which is also the order [HouseholdMembersScreen] stacks the same four. An
 * earlier version promoted Expired above Accepted; the mock is the authority
 * for order and it does not.
 */
private val SECTION_ORDER: List<Pair<String, List<MembersRepository.InviteStatus>>> = listOf(
    "Pending" to listOf(
        MembersRepository.InviteStatus.PENDING,
        MembersRepository.InviteStatus.EMAIL_SENT,
    ),
    "Accepted" to listOf(MembersRepository.InviteStatus.ACCEPTED),
    "Expired" to listOf(MembersRepository.InviteStatus.EXPIRED),
    "Revoked" to listOf(MembersRepository.InviteStatus.REVOKED),
)

internal fun groupInvitesByStatus(
    rows: List<MembersRepository.AdminInvite>,
): List<InviteSection> = SECTION_ORDER.map { (heading, statuses) ->
    InviteSection(
        heading = heading,
        statusNote = "status: " + statuses.joinToString(" / ") { it.name },
        rows = rows.filter { it.invite.effectiveStatus in statuses },
    )
}

data class InvitesUiState(
    val all: List<MembersRepository.AdminInvite> = emptyList(),
    val filter: InviteFilter = InviteFilter.OUTSTANDING,
    val loading: Boolean = false,
    /** True only after a load that actually succeeded. Gates the empty state. */
    val loaded: Boolean = false,
    val error: String? = null,
) {
    val visible: List<MembersRepository.AdminInvite> get() = filterInvites(all, filter)

    val sections: List<InviteSection> get() = groupInvitesByStatus(visible)

    /**
     * How many rows a filter would show. Counted off the rows that were really
     * read, so a failed load leaves every chip at zero rather than advertising
     * a number nobody could see behind it.
     */
    fun countFor(filter: InviteFilter): Int = filterInvites(all, filter).size
}

class InvitesViewModel(
    private val repository: MembersRepository = MembersRepository(),
) : ViewModel() {

    private val _uiState = MutableStateFlow(InvitesUiState())
    val uiState: StateFlow<InvitesUiState> = _uiState.asStateFlow()

    fun load() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(loading = true, error = null)
            repository.listAllInvites().fold(
                onSuccess = { rows ->
                    _uiState.value = _uiState.value.copy(
                        all = rows,
                        loading = false,
                        loaded = true,
                    )
                },
                onFailure = { err ->
                    // `loaded` and `all` stay as they were: a failed reload must
                    // not turn a list somebody already read into an unknown one,
                    // and must never promote an unknown one into a proven-empty
                    // one.
                    _uiState.value = _uiState.value.copy(
                        loading = false,
                        error = "listAllInvites failed: ${err.message ?: "Load failed"}",
                    )
                },
            )
        }
    }

    /** Re-slices rows already in hand. Never a second round trip. */
    fun setFilter(filter: InviteFilter) {
        _uiState.value = _uiState.value.copy(filter = filter)
    }

    fun clearError() {
        _uiState.value = _uiState.value.copy(error = null)
    }
}
