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

    /**
     * #907 review item 1(a): the household each operator last Discarded. Discard
     * says the next Add is a new household, so the next create sends this id as
     * `ignoreDuplicateOf` and the server's duplicate check skips it.
     */
    private val discardedByOperator = mutableStateMapOf<String, String>()

    fun discard(operatorUid: String?, kinfolkId: String) {
        if (kinfolkId.isNotBlank()) discardedByOperator[operatorUid.orEmpty()] = kinfolkId
    }

    fun discardedFor(operatorUid: String?): String? = discardedByOperator[operatorUid.orEmpty()]

    fun clearDiscarded(operatorUid: String?) {
        discardedByOperator.remove(operatorUid.orEmpty())
    }

    /**
     * #907 review item 1(b): what an operator typed into an Add the server answered
     * with `duplicateOf`, kept for that household's edit screen. One per operator.
     */
    private val duplicateByOperator = mutableStateMapOf<String, PendingKinfolk>()

    fun keepDuplicate(operatorUid: String?, typed: PendingKinfolk) {
        duplicateByOperator[operatorUid.orEmpty()] = typed
    }

    /** The typing for THIS household only; another household's edit screen never sees it. */
    fun duplicateFor(operatorUid: String?, kinfolkId: String): PendingKinfolk? =
        duplicateByOperator[operatorUid.orEmpty()]?.takeIf { it.kinfolkId == kinfolkId }

    fun clearDuplicate(operatorUid: String?) {
        duplicateByOperator.remove(operatorUid.orEmpty())
    }

    /** Test seam: forget every operator's pending, discarded and duplicate households. */
    fun clearAll() {
        byOperator.clear()
        discardedByOperator.clear()
        duplicateByOperator.clear()
    }
}

/**
 * #907 review item 1(b): the stored household with a duplicate Add's typing laid
 * over it. A typed value counts only when it is not blank and differs from the
 * stored one once both are trimmed; a blank is "not typed", never "clear it". The
 * id, status and everything Add has no field for stay as stored.
 */
fun overlayDuplicateAdd(stored: Kinfolk, typed: Kinfolk): Kinfolk {
    fun pick(t: String, s: String): String = if (t.isNotBlank() && t.trim() != s.trim()) t.trim() else s
    return stored.copy(
        firstName           = pick(typed.firstName, stored.firstName),
        lastName            = pick(typed.lastName, stored.lastName),
        phoneNumber         = pick(typed.phoneNumber, stored.phoneNumber),
        secondaryPhone      = pick(typed.secondaryPhone, stored.secondaryPhone),
        email               = pick(typed.email, stored.email),
        secondaryEmail      = pick(typed.secondaryEmail, stored.secondaryEmail),
        serviceAddress      = pick(typed.serviceAddress, stored.serviceAddress),
        gateCode            = pick(typed.gateCode, stored.gateCode),
        parkingInstructions = pick(typed.parkingInstructions, stored.parkingInstructions),
        entryNotes          = pick(typed.entryNotes, stored.entryNotes),
        wifiName            = pick(typed.wifiName, stored.wifiName),
        wifiPassword        = pick(typed.wifiPassword, stored.wifiPassword),
        internalNotes       = pick(typed.internalNotes, stored.internalNotes),
        referralSource      = pick(typed.referralSource, stored.referralSource),
        vetClinicName       = pick(typed.vetClinicName, stored.vetClinicName),
        vetClinicPhone      = pick(typed.vetClinicPhone, stored.vetClinicPhone),
        vetClinicAddress    = pick(typed.vetClinicAddress, stored.vetClinicAddress),
        formValues          = stored.formValues + typed.formValues.filter { (k, v) ->
            v.isNotBlank() && v.trim() != stored.formValues[k].orEmpty().trim()
        }.mapValues { it.value.trim() },
    )
}

/**
 * #907 review item 1(b): the edit screen's notice. The desktop edit screen has no
 * status control (status is set on Add only), so a status typed on Add that differs
 * is named here rather than filled in.
 */
fun duplicateAddNotice(stored: Kinfolk, typed: Kinfolk): String {
    val name = "${stored.firstName.trim()} ${stored.lastName.trim()}".trim().ifBlank { "This household" }
    val notice = "$name was already added a few minutes ago. What you typed in Add that differs is filled in below and is not saved yet."
    val typedStatus = typed.status.trim()
    return if (typedStatus.isNotBlank() && !typedStatus.equals(stored.status.trim(), ignoreCase = true)) {
        "$notice Status on Add was $typedStatus; this household is ${stored.status.trim().ifBlank { "blank" }}, and status is not changed here."
    } else notice
}

/** How the Continue prompt names the household. */
fun pendingHouseholdName(pending: PendingKinfolk): String =
    "${pending.household.firstName.trim()} ${pending.household.lastName.trim()}".trim().ifBlank { "this household" }
