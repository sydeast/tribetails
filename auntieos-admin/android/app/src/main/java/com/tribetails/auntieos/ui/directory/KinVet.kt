package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.VetClinic

/**
 * #1908 kin-vet (owner ruling 2026-11-12): "The vet field on the Kin profile in
 * both view & edit mode is read only and pulls its data from the vet listed on
 * the household. The edit view should have a checkbox (defaulted unmarked) that
 * when checked it allows the editor to select a different vet from the drop
 * down list."
 *
 * So a Kin carries only an override, `kin.ownVetClinicId` ("" goes to the
 * household's vet), and every screen resolves the vet the Kin goes to through
 * here, the same rule the portal's `getMyKin` applies to its `vet`.
 */
data class KinVet(
    /** The practice the Kin goes to, resolved through the clinic catalog. */
    val vet: ResolvedVet,
    /** True when it is the household's vet; false when the Kin has its own. */
    val fromHousehold: Boolean,
)

/** The vet [ownVetClinicId]'s Kin goes to: its own clinic when it has one, else the household's. */
fun resolveKinVet(ownVetClinicId: String?, household: HouseholdVet, clinics: List<VetClinic>): KinVet {
    val own = ownVetClinicId.orEmpty().trim()
    if (own.isEmpty()) return KinVet(vet = household.primary, fromHousehold = true)
    val clinic = clinics.firstOrNull { it.id == own }
        // Fail loud on a link that points nowhere, never a quiet fall back to
        // the household's vet: that would show a number the Kin is not seen at.
        ?: return KinVet(vet = ResolvedVet(linked = true, dangling = true), fromHousehold = false)
    return KinVet(
        vet = ResolvedVet(
            name = clinic.name.trim(),
            phone = clinic.phone.trim(),
            address = clinic.address.trim(),
            hours = clinic.hours.trim(),
            linked = true,
            archived = clinic.archived,
        ),
        fromHousehold = false,
    )
}

/**
 * The clinics the "Different vet for this Kin" dropdown offers: every clinic on
 * the area vet list a household may pick, by name. An archived clinic and a
 * submission still waiting for the office are left out, the same rule the
 * server's `updateKin` enforces for a household.
 */
fun pickableVetClinics(clinics: List<VetClinic>): List<VetClinic> =
    clinics.filter { !it.archived && it.verified && it.name.isNotBlank() }
        .sortedBy { it.name.trim().lowercase() }

/** One line for a resolved practice: name, phone and address, blanks dropped. */
fun vetLine(vet: ResolvedVet): String =
    listOf(vet.name, vet.phone, vet.address).map { it.trim() }.filter { it.isNotBlank() }.joinToString(" · ")

/**
 * What a save writes to `ownVetClinicId`: the clinic picked when the box is
 * ticked, "" when it is not. Unticking the box is how a Kin goes back to the
 * household's vet, so it always clears, whatever was picked before.
 */
fun ownVetClinicIdToSave(differentVet: Boolean, picked: String): String =
    if (differentVet) picked.trim() else ""

/** The old free-text vet note is shown, labelled, only when no clinic resolves. */
fun showLegacyVetNote(kinVet: KinVet, vetInfo: String?): Boolean =
    !kinVet.vet.hasAny && vetInfo.orEmpty().isNotBlank()
