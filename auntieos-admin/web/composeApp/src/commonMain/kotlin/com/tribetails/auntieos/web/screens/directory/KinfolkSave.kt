package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.EmergencyContactDraft
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.draftsEqual
import com.tribetails.auntieos.web.data.isBlankDrafts

/** What one press of Save on KinfolkEditScreen came to (#829). */
sealed interface KinfolkSaveOutcome {
    data class Saved(val kinfolkId: String) : KinfolkSaveOutcome

    /** The household write itself failed; nothing was saved. */
    data class HouseholdFailed(val message: String) : KinfolkSaveOutcome

    /**
     * The household is on file (created or updated) but the Emergency Contact
     * save failed. On Add, [kinfolkId] is what the retry saves contacts against.
     */
    data class ContactsFailed(val kinfolkId: String, val message: String) : KinfolkSaveOutcome
}

/**
 * The household step of a save. [wrote] is false when an edit changed nothing,
 * so no write was sent (#829 review: nothing is audited then).
 */
data class HouseholdWrite(val kinfolkId: String, val wrote: Boolean = true)

/**
 * Whether this save must call `saveEmergencyContacts`. Always on Add (a household
 * needs one). On edit, only when the editor changed, and never when a household
 * with none on file is saved with the editor still blank: the "No Emergency
 * Contact" flag is not a block on other edits.
 */
fun emergencyContactsNeedSaving(
    isNew: Boolean,
    drafts: List<EmergencyContactDraft>,
    baseline: List<EmergencyContactDraft>,
): Boolean {
    if (isNew) return true
    val skipped = baseline.isBlankDrafts() && drafts.isBlankDrafts()
    return !draftsEqual(drafts, baseline) && !skipped
}

/**
 * #829 review: the value a trimmed form field saves. If what is typed matches the
 * stored value once both are trimmed, the stored value stands, so a record with
 * stray whitespace neither shows as changed on open nor gets rewritten by a save
 * with no edits. A real edit saves trimmed.
 */
fun keepStoredUnlessEdited(typed: String, stored: String): String =
    if (typed.trim() == stored.trim()) stored else typed.trim()

/**
 * The save sequence, kept out of the composable so it can be tested.
 *
 * - [retryKinfolkId] set: an Add whose contact save failed earlier. Only the
 *   contacts are saved; [writeHousehold] is never called, so a retry cannot
 *   create a second household.
 * - Otherwise the household step runs first. [onHouseholdWritten] (the audit log)
 *   runs only when that step actually wrote something, then the contacts are
 *   saved when [saveContacts].
 */
suspend fun saveKinfolkWithContacts(
    retryKinfolkId: String?,
    saveContacts: Boolean,
    writeHousehold: suspend () -> WriteResult<HouseholdWrite>,
    writeContacts: suspend (kinfolkId: String) -> WriteResult<*>,
    onHouseholdWritten: (kinfolkId: String) -> Unit,
): KinfolkSaveOutcome {
    if (retryKinfolkId != null) {
        return when (val ec = writeContacts(retryKinfolkId)) {
            is WriteResult.Ok -> KinfolkSaveOutcome.Saved(retryKinfolkId)
            is WriteResult.Err -> KinfolkSaveOutcome.ContactsFailed(retryKinfolkId, ec.message)
        }
    }
    val household = when (val h = writeHousehold()) {
        is WriteResult.Err -> return KinfolkSaveOutcome.HouseholdFailed(h.message)
        is WriteResult.Ok -> h.value
    }
    val id = household.kinfolkId
    if (household.wrote) onHouseholdWritten(id)
    if (!saveContacts) return KinfolkSaveOutcome.Saved(id)
    return when (val ec = writeContacts(id)) {
        is WriteResult.Ok -> KinfolkSaveOutcome.Saved(id)
        is WriteResult.Err -> KinfolkSaveOutcome.ContactsFailed(id, ec.message)
    }
}
