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
    val starts = clinics.filter { it.name.lowercase().startsWith(q) }
    val contains = clinics.filter { !it.name.lowercase().startsWith(q) && it.name.lowercase().contains(q) }
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
