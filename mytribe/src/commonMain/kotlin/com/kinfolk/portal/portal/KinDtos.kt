package com.kinfolk.portal.portal

enum class KinStatus { Active, NoLongerWithUs }

data class Kin(
    val id: String,
    val name: String?,
    val species: String?,
    val breed: String?,
    val ageYears: Double?,
    val photoUrl: String?,
    val status: KinStatus,
    // `aiBlurb` REMOVED 2026-08-18. It carried `the_411.rawSummary`, which is
    // admin-only by operator ruling, to the household. See getMyKin.ts.
    val feedingInstructions: String?,
    val walkingInstructions: String?,
    val medications: String?,
    val allergies: String?,
    val emergencyNotes: String?,
    val sitterNotes: String?,
    // The five descriptive facts shared with the admin (getMyKin.ts, #1310).
    val sex: String? = null,
    val weight: String? = null,
    val colorMarkings: String? = null,
    val spayedNeutered: Boolean = false,
    /** Legacy free-text vet note. No longer an input (#1908 kin-vet); shown only when no clinic resolves. */
    val vetInfo: String? = null,
    // #1908 (owner ruling 2026-11-11): the care facts the admin always kept,
    // now the household's to fill too.
    val staysAs: String? = null,
    val routine: String? = null,
    val trainingCommands: String? = null,
    val feedingBrand: String? = null,
    val vaccinations: String? = null,
    /** #1908 kin-vet: a clinic for this Kin alone, "" when it goes to the household's vet. */
    val ownVetClinicId: String = "",
    /**
     * The vet this Kin goes to, as getMyKin resolved it. Null from a direct
     * Firestore read (the household's vet store is staff-only there) and when
     * neither vet resolves; [resolveKinVet] fills the first case on the client.
     */
    val vet: KinVet? = null,
)
/** The vet a Kin goes to: its own clinic, or the household's ([fromHousehold]). */
data class KinVet(val clinic: VetClinicSummary, val fromHousehold: Boolean)
/**
 * #1908 kin-vet. The vet a Kin goes to, for display. The server's answer wins
 * when it has one. Otherwise: a Kin with its own clinic goes to that clinic,
 * looked up in the area list ([clinics]); a Kin without one goes to the
 * household's ([householdVet], from the Tribe Profile). An own clinic that no
 * longer resolves is no vet, never the household's in disguise.
 */
fun resolveKinVet(kin: Kin, householdVet: VetClinicSummary?, clinics: List<VetClinic>): KinVet? {
    kin.vet?.let { return it }
    val own = kin.ownVetClinicId.trim()
    if (own.isNotEmpty()) {
        val c = clinics.firstOrNull { it.id == own } ?: return null
        return KinVet(VetClinicSummary(c.id, c.name, c.phone, c.address, c.isEmergency), fromHousehold = false)
    }
    return householdVet?.takeIf { it.name.isNotBlank() }?.let { KinVet(it, fromHousehold = true) }
}

data class KinResult(val kin: List<Kin>)

/**
 * One Kin a booking can cover: the server's own roster entry. [id] is the id a
 * booking stores for the Kin and the one the wizard sends back. [householdId]
 * is the Kin's own card ([Kin.id] from `getMyKin`), null for a Kin the office
 * added that has no card yet.
 */
data class RosterKin(val id: String, val name: String?, val householdId: String? = id)

/**
 * The Kin a booking for this household covers, as the server will store them
 * (#1822, #1862), and whether they may be narrowed. [chooseKin] is false by
 * default: every booking covers every Kin and the wizard shows no picker.
 */
data class KinRoster(val kin: List<RosterKin>, val chooseKin: Boolean)

/** Dog + cat breed name lists for the Kin breed dropdown (from getBreeds). */
data class BreedsResult(val dogBreeds: List<String>, val catBreeds: List<String>)
