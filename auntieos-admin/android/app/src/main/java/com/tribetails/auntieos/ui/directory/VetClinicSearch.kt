package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.VetClinic

/**
 * Pure filter for the vet-clinic search box. Prefix matches rank first, then substring
 * matches, capped at [limit] so a 100+ clinic catalog stays a short, scannable dropdown.
 * A blank query returns nothing: the box is a search field, not a full-catalog dump.
 * Mirrors the web helper of the same name.
 */
fun vetClinicSuggestions(query: String, clinics: List<VetClinic>, limit: Int = 8): List<VetClinic> {
    val q = query.trim().lowercase()
    if (q.isEmpty()) return emptyList()
    // Retired clinics drop out of what can be PICKED, which is what retiring one
    // is for. A household already on an archived clinic is unaffected: it keeps
    // its own stored name, phone and address, so its field still shows what is
    // on file. The row simply stops being offered to anyone choosing from now on.
    val live = clinics.filter { !it.archived }
    val starts = live.filter { it.name.lowercase().startsWith(q) }
    val contains = live.filter { !it.name.lowercase().startsWith(q) && it.name.lowercase().contains(q) }
    return (starts + contains).take(limit)
}

/**
 * The 24 hour clinics, for the household's EMERGENCY vet field. Filtering is
 * kept out of [vetClinicSuggestions] so one ranking rule serves both pickers and
 * cannot drift between them; the emergency picker filters its input instead.
 *
 * A daytime practice in the emergency slot is worse than a blank one: it reads
 * as an answer at 2am and is not.
 */
fun emergencyVetClinics(clinics: List<VetClinic>): List<VetClinic> = clinics.filter { it.isEmergency }

/**
 * The label on the create button pinned at the bottom of the dropdown. Quotes
 * the TRIMMED query, because the trimmed text is what gets sent as the name.
 */
fun createVetClinicLabel(query: String): String = "Create \"${query.trim()}\" as a new vet clinic"

/**
 * Whether the pinned create button is offered. True whenever anything has been
 * typed, INCLUDING when nothing matched, which is exactly the case the button
 * exists for (operator issue #13: "there is a button at the very bottom of the
 * dropdown for them to create a vet clinic"). A blank query only means nothing
 * has been typed yet, so there is no clinic to name.
 *
 * `clinics` is taken but unread on purpose: the answer must NOT depend on the
 * match count. Reading it here is how "hide the button when there are matches"
 * gets reintroduced by someone who thinks it looks tidier.
 */
@Suppress("UNUSED_PARAMETER")
fun shouldOfferVetClinicCreate(query: String, clinics: List<VetClinic>): Boolean = query.trim().isNotEmpty()

// ── the committed selection ──────────────────────────────────────────────────

/**
 * What a household stores for a vet: the catalog id, plus the name, phone and
 * address denormalized alongside it. Mirrors the web `VetClinicSelection`.
 *
 * The denormalized copy is not redundancy for its own sake. An Auntie standing
 * on a doorstep needs the clinic's phone off the household record without a
 * second read, and a clinic later renamed or removed from the bank must not
 * blank the number on file. [clinicId] is what makes the link repairable; the
 * three strings are what make it useful.
 *
 * A LEGACY household has the three strings and an EMPTY [clinicId]. That is a
 * valid, renderable state, not an error: it is the state every household saved
 * before 2026-07-25 is in.
 */
data class VetClinicSelection(
    val clinicId: String = "",
    val name: String = "",
    val phone: String = "",
    val address: String = "",
) {
    /** Keyed on the NAME as well as the id, so a legacy vet counts as a selection. */
    val hasSelection: Boolean get() = clinicId.isNotBlank() || name.isNotBlank()

    /** A vet on file that is not joined to a catalog row. Legacy, not broken. */
    val unlinked: Boolean get() = clinicId.isBlank() && name.isNotBlank()

    /** Phone and address as one secondary line, omitting whichever is missing. */
    val detail: String get() = listOf(phone, address).filter { it.isNotBlank() }.joinToString(" · ")
}

val EMPTY_VET_CLINIC_SELECTION = VetClinicSelection()

/** A catalog row as a committed selection: the id, plus the denormalized copy. */
fun vetClinicSelectionOf(clinic: VetClinic) = VetClinicSelection(
    clinicId = clinic.id,
    name = clinic.name.trim(),
    phone = clinic.phone.trim(),
    address = clinic.address.trim(),
)

/**
 * What the picker says about a legacy vet. Honest rather than alarming: the
 * record works, it simply is not joined to the bank yet, and the operator is
 * told how to join it if and when they want to. Verbatim from the web picker so
 * an operator reading both surfaces gets the same sentence.
 */
const val VET_CLINIC_UNLINKED_NOTE =
    "Not linked to the shared catalog. Clear it and search to link this household to a clinic record."
