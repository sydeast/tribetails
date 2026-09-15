package com.tribetails.auntieos.web.screens.directory

import androidx.compose.runtime.mutableStateMapOf
import com.tribetails.auntieos.web.data.EmergencyContactDraft
import com.tribetails.auntieos.web.data.Kinfolk

/**
 * #890: a household Add Kinfolk created whose Emergency Contact has not saved yet.
 *
 * Add creates the household, then saves its contact. When the contact save failed
 * and the operator left the screen, the created id used to live only in
 * [KinfolkEditScreen]'s state and was gone, so the next Add made a second
 * household. This keeps it at app level, per operator, for as long as the console
 * runs, until the contact saves or the operator chooses Discard. Admin Android
 * keeps the same thing in DirectoryViewModel (`leaveAddKinfolk`); admin web keeps
 * it in session storage (`lib/pendingAddKinfolk.ts`).
 *
 * [household] is the form as it was saved, so continuing shows the same locked
 * fields; [contacts] is the contact as last typed.
 */
data class PendingKinfolk(
    val kinfolkId: String,
    val household: Kinfolk,
    val contacts: List<EmergencyContactDraft>,
)

object PendingAddKinfolk {
    /** Compose state, so a screen reading it recomposes when Discard clears it. Keyed by operator uid. */
    private val byOperator = mutableStateMapOf<String, PendingKinfolk>()

    fun get(operatorUid: String?): PendingKinfolk? = byOperator[operatorUid.orEmpty()]

    fun keep(operatorUid: String?, pending: PendingKinfolk) {
        byOperator[operatorUid.orEmpty()] = pending
    }

    fun clear(operatorUid: String?) {
        byOperator.remove(operatorUid.orEmpty())
    }

    /** Test seam: forget every operator's pending household. */
    fun clearAll() {
        byOperator.clear()
    }
}

/** How the Continue prompt names the household. */
fun pendingHouseholdName(pending: PendingKinfolk): String =
    "${pending.household.firstName.trim()} ${pending.household.lastName.trim()}".trim().ifBlank { "this household" }
