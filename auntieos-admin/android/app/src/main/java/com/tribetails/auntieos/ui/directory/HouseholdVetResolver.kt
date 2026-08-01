package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.HouseholdData
import com.tribetails.auntieos.data.model.VetClinic

/**
 * Resolving the household vet for DISPLAY. The Kotlin mirror of
 * `auntieos-admin/src/lib/householdVet.ts`; the two must agree field for field.
 *
 * `household_data` is the canonical store (operator ruling 2026-08-01: "vet info
 * lives on household data, it can be seen on the kin profile", matching
 * page-specs 04-kinfolk-profile.md item 3), and it holds a `vet_clinics`
 * document id rather than copied strings. Everything shown resolves THROUGH the
 * clinic, which is what makes a correction in the vet clinics manager reach
 * every household at once: there is only ever one copy.
 *
 * One resolver for every Android surface that renders a vet, so the household
 * profile, Household Data and the kin detail cannot drift into showing
 * different vets for the same household. That drift is the defect this change
 * exists to close, and independent read paths would quietly reintroduce it.
 */
data class ResolvedVet(
    val name: String = "",
    val phone: String = "",
    val address: String = "",
    val hours: String = "",
    /**
     * True when this came from a catalog row. False means the household still
     * carries legacy free text with no clinic id, which the screens LABEL rather
     * than hide: a correction cannot reach an unlinked record, and that is worth
     * saying out loud on a screen read under pressure.
     */
    val linked: Boolean = false,
    /** True when the linked clinic has been retired from the bank. */
    val archived: Boolean = false,
    /** True when the id points at a clinic that no longer exists. Fail loud. */
    val dangling: Boolean = false,
) {
    val hasAny: Boolean get() = name.isNotBlank() || phone.isNotBlank() || address.isNotBlank()
}

data class HouseholdVet(
    val primary: ResolvedVet = ResolvedVet(),
    /** A DISTINCT practice from the primary, never folded into it. */
    val emergency: ResolvedVet = ResolvedVet(),
)

private fun resolveSlot(
    clinicId: String,
    clinics: List<VetClinic>,
    legacyName: String,
    legacyPhone: String,
    legacyAddress: String,
    legacyHours: String,
): ResolvedVet {
    val id = clinicId.trim()
    if (id.isEmpty()) {
        // Unlinked: show what is on file rather than nothing. A household that
        // predates the catalog still has a real vet, and blanking it to make a
        // point about the data model would remove a number somebody needs.
        return ResolvedVet(
            name = legacyName.trim(),
            phone = legacyPhone.trim(),
            address = legacyAddress.trim(),
            hours = legacyHours.trim(),
            linked = false,
        )
    }

    val clinic = clinics.firstOrNull { it.id == id }
        // The id points nowhere. NEVER silently fall back to the legacy text:
        // that hides a broken link behind stale data, which is precisely how a
        // wrong number survives. Reported so the screen can say so.
        ?: return ResolvedVet(linked = true, dangling = true)

    return ResolvedVet(
        name = clinic.name.trim(),
        phone = clinic.phone.trim(),
        address = clinic.address.trim(),
        hours = clinic.hours.trim(),
        linked = true,
        archived = clinic.archived,
    )
}

/**
 * The household's vet, resolved for display.
 *
 * [clinics] is the catalog. Passing an empty list makes any linked id read as
 * `dangling`, so a caller must not render this until the catalog read lands.
 */
fun resolveHouseholdVet(household: HouseholdData?, clinics: List<VetClinic>): HouseholdVet {
    if (household == null) return HouseholdVet()
    return HouseholdVet(
        primary = resolveSlot(
            clinicId = household.primaryVetClinicId,
            clinics = clinics,
            legacyName = household.primaryVetName,
            legacyPhone = household.primaryVetPhone,
            legacyAddress = household.primaryVetAddress,
            // The legacy per-household hours field, superseded by
            // `vet_clinics.hours`. A LINKED household never reads it.
            legacyHours = household.primaryVetHours,
        ),
        emergency = resolveSlot(
            clinicId = household.emergencyVetClinicId,
            clinics = clinics,
            legacyName = household.emergencyVetName,
            legacyPhone = household.emergencyVetPhone,
            legacyAddress = household.emergencyVetAddress,
            // No legacy emergency-hours field ever existed.
            legacyHours = "",
        ),
    )
}
