package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.HouseholdData

/**
 * #1908 kin-vet (owner ruling 2026-11-12): the household vet is "a dropdown
 * field preloaded with all vets in the entire area", set by the admin and the
 * household alike. On `household_data` it is a `vet_clinics` id
 * (`primaryVetClinicId`, and `emergencyVetClinicId` for the emergency vet), the
 * one store admin web, Android and the portal read. The free-text vet fields
 * are the legacy record of a household that predates the list: shown read-only
 * while no clinic is linked, never edited here. Pure; unit-tested.
 */

/** The household's clinic id in [slot], or "". */
fun householdVetClinicId(data: HouseholdData?, slot: HouseholdVetSlot): String = when (slot) {
    HouseholdVetSlot.PRIMARY   -> data?.primaryVetClinicId.orEmpty()
    HouseholdVetSlot.EMERGENCY -> data?.emergencyVetClinicId.orEmpty()
}

/**
 * The document after picking [clinicId] for [slot] ("" removes the link):
 * [loaded] with that one link changed, so the diffed save carries the link and
 * nothing else. A household with no doc yet gets one for [kinfolkId].
 */
fun withHouseholdVet(loaded: HouseholdData?, kinfolkId: String, slot: HouseholdVetSlot, clinicId: String): HouseholdData {
    val base = loaded ?: HouseholdData(kinfolkId = kinfolkId)
    val id = clinicId.trim()
    return when (slot) {
        HouseholdVetSlot.PRIMARY   -> base.copy(kinfolkId = kinfolkId, primaryVetClinicId = id)
        HouseholdVetSlot.EMERGENCY -> base.copy(kinfolkId = kinfolkId, emergencyVetClinicId = id)
    }
}

/**
 * The legacy free-text vet lines for [slot], label to value, shown read-only
 * only while the slot has no clinic linked. Blank values are left out.
 */
fun legacyHouseholdVetLines(data: HouseholdData?, slot: HouseholdVetSlot): List<Pair<String, String>> {
    if (data == null || householdVetClinicId(data, slot).isNotBlank()) return emptyList()
    val lines = when (slot) {
        HouseholdVetSlot.PRIMARY -> listOf(
            "Name" to data.primaryVetName,
            "Phone" to data.primaryVetPhone,
            "Address" to data.primaryVetAddress,
            "Hours" to data.primaryVetHours,
        )
        HouseholdVetSlot.EMERGENCY -> listOf(
            "Name" to data.emergencyVetName,
            "Phone" to data.emergencyVetPhone,
            "Address" to data.emergencyVetAddress,
        )
    }
    return lines.filter { it.second.isNotBlank() }.map { it.first to it.second.trim() }
}
