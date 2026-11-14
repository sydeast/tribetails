package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.VetClinic

/**
 * #1908 kin-vet (owner ruling 2026-11-12): "The vet field on the Kin profile in
 * both view & edit mode is read only and pulls its data from the vet listed on
 * the household. The edit view should have a checkbox (defaulted unmarked) that
 * when checked it allows the editor to select a different vet from the drop
 * down list."
 *
 * The household's vet is `household_data.primaryVetClinicId`. A Kin carries only
 * `ownVetClinicId`, a clinic for this Kin alone, or "" for the household's. The
 * inherited clinic is never copied onto the Kin, so a change to the household
 * vet reaches every Kin that has none of its own. Pure; unit-tested.
 */

/** Label of the checkbox on Edit kin. */
const val DIFFERENT_VET_LABEL = "Different vet for this Kin"

/** What the vet row shows for a Kin. */
data class KinVetLine(
    /** The clinic the Kin goes to, or null when none resolves. */
    val clinic: VetClinic?,
    /** True when [clinic] is the household's vet rather than the Kin's own. */
    val fromHousehold: Boolean,
    /** The legacy free-text vet note, shown (labelled) only when no clinic resolves. */
    val legacyNote: String,
)

/**
 * The clinics a vet dropdown offers: the whole area list, minus clinics retired
 * from the bank and submissions still waiting for the office. By name.
 */
fun pickableVetClinics(all: List<VetClinic>): List<VetClinic> =
    all.filter { !it.archived && it.verified && it.name.isNotBlank() }
        .sortedBy { it.name.lowercase() }

/**
 * The vet a Kin goes to. Its own clinic when it has one; else the household's.
 * A Kin whose own clinic no longer exists shows no clinic rather than the
 * household's, which would name a vet nobody chose for it. Lookups read the
 * whole list, archived clinics included: a Kin already on one still shows it.
 */
fun resolveKinVet(kin: Kin, householdVetClinicId: String, clinics: List<VetClinic>): KinVetLine {
    val own = kin.ownVetClinicId.trim()
    val clinic = if (own.isNotEmpty()) {
        clinics.firstOrNull { it._id == own }
    } else {
        householdVetClinicId.trim().takeIf { it.isNotEmpty() }?.let { id -> clinics.firstOrNull { it._id == id } }
    }
    return KinVetLine(
        clinic = clinic,
        fromHousehold = own.isEmpty() && clinic != null,
        legacyNote = if (clinic == null) kin.vetInfo.trim() else "",
    )
}

/** The clinic's name, phone and address on one line. */
fun vetClinicLine(clinic: VetClinic): String =
    listOf(clinic.name, clinic.phone, clinic.address).filter { it.isNotBlank() }.joinToString(" · ")

/** What Edit kin saves: the picked clinic when the box is ticked, else "" (the household's vet). */
fun ownVetClinicIdForSave(differentVet: Boolean, pickedClinicId: String): String =
    if (differentVet) pickedClinicId.trim() else ""

/** True when the form can save: a ticked box needs a clinic picked. */
fun differentVetIsComplete(differentVet: Boolean, pickedClinicId: String): Boolean =
    !differentVet || pickedClinicId.isNotBlank()
/**
 * The clinics a vet dropdown shows for what the admin has typed: name or
 * address containing [query], ignoring case. A blank query lists them all, so
 * the list is there the moment the dropdown opens.
 */
fun filterVetClinics(clinics: List<VetClinic>, query: String): List<VetClinic> {
    val q = query.trim().lowercase()
    if (q.isEmpty()) return clinics
    return clinics.filter { it.name.lowercase().contains(q) || it.address.lowercase().contains(q) }
}
/** The household vet slots on `household_data`. */
enum class HouseholdVetSlot { PRIMARY, EMERGENCY }
/** What a slot's dropdown offers: the emergency slot takes only clinics flagged emergency. */
fun householdVetOptions(clinics: List<VetClinic>, slot: HouseholdVetSlot): List<VetClinic> {
    val pickable = pickableVetClinics(clinics)
    return if (slot == HouseholdVetSlot.EMERGENCY) pickable.filter { it.isEmergency } else pickable
}
