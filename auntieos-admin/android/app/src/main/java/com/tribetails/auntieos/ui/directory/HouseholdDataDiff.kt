package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.HouseholdData

/**
 * What a household save is allowed to write: the fields that ACTUALLY CHANGED
 * since the record was read, and nothing else.
 *
 * WHY A DIFF AND NOT THE MODEL. The save used to hand Firestore the whole
 * loaded `HouseholdData` under `SetOptions.merge()`. `merge()` protects fields
 * OUTSIDE the written map; it does nothing for stale fields INSIDE it. So every
 * one of the fields below went back at whatever value the phone read, and any
 * edit made on the React admin in between was silently reverted, including
 * `primaryVetClinicId` - the clinic a sitter phones in an emergency.
 *
 * The React admin already writes this way and says why:
 * `auntieos-admin/src/api/householdData.ts:110-127`, which cites the 2026-07-20
 * `familyKinPath` data-loss incident as the reason it patches rather than sets.
 * This is the same rule for the same collection from the other client.
 *
 * The list is written out by hand rather than reflected, so it survives R8 and
 * reads as the contract it is. `HouseholdFieldChangesTest` reflects over the
 * model and fails if the two ever drift, because a field missing from here
 * would simply stop saving - a quieter loss than the one being fixed.
 *
 * `id`, `kinfolkId`, `createdAt` and `updatedAt` are deliberately absent. The
 * first three are the document's identity, already stored and never edited on
 * this screen; `updatedAt` is stamped by the repository at write time, never
 * round-tripped from what was read.
 */
internal val HOUSEHOLD_DIFF_FIELDS: Map<String, (HouseholdData) -> String> = linkedMapOf(
    // The canonical, catalog-linked vet (operator ruling 2026-08-01).
    "primaryVetClinicId" to { it: HouseholdData -> it.primaryVetClinicId },
    "emergencyVetClinicId" to { it: HouseholdData -> it.emergencyVetClinicId },
    // Legacy free text, still diffed: this screen no longer authors it, but a
    // migration or a future editor might, and dropping it here would mean a save
    // that quietly refuses to persist it.
    "primaryVetName" to { it: HouseholdData -> it.primaryVetName },
    "primaryVetPhone" to { it: HouseholdData -> it.primaryVetPhone },
    "primaryVetAddress" to { it: HouseholdData -> it.primaryVetAddress },
    "primaryVetHours" to { it: HouseholdData -> it.primaryVetHours },
    "emergencyVetName" to { it: HouseholdData -> it.emergencyVetName },
    "emergencyVetPhone" to { it: HouseholdData -> it.emergencyVetPhone },
    "emergencyVetAddress" to { it: HouseholdData -> it.emergencyVetAddress },
    // Household Items & Locations
    "foodLocation" to { it: HouseholdData -> it.foodLocation },
    "treatLocation" to { it: HouseholdData -> it.treatLocation },
    "medicationLocation" to { it: HouseholdData -> it.medicationLocation },
    "toysLocation" to { it: HouseholdData -> it.toysLocation },
    "beddingLocation" to { it: HouseholdData -> it.beddingLocation },
    "leashesPoopBagsLocation" to { it: HouseholdData -> it.leashesPoopBagsLocation },
    "cleaningSuppliesLocation" to { it: HouseholdData -> it.cleaningSuppliesLocation },
    // Household Routines & Preferences
    "householdRules" to { it: HouseholdData -> it.householdRules },
    "preferredWalkRoutes" to { it: HouseholdData -> it.preferredWalkRoutes },
    "neighborhoodHazards" to { it: HouseholdData -> it.neighborhoodHazards },
    "securitySystemInfo" to { it: HouseholdData -> it.securitySystemInfo },
    "thermostatInstructions" to { it: HouseholdData -> it.thermostatInstructions },
    "lightingPreferences" to { it: HouseholdData -> it.lightingPreferences },
    // Emergency & Safety - no card renders these today, and that is precisely why
    // they must be diffed: unrendered means unchanged, so they are never written.
    "poisonControlNumber" to { it: HouseholdData -> it.poisonControlNumber },
    "emergencyContactsPriority" to { it: HouseholdData -> it.emergencyContactsPriority },
    "evacuationPlan" to { it: HouseholdData -> it.evacuationPlan },
    "importantDocumentsLocation" to { it: HouseholdData -> it.importantDocumentsLocation },
    // Service Providers - same, unrendered since 2026-08-04.
    "groomerName" to { it: HouseholdData -> it.groomerName },
    "groomerPhone" to { it: HouseholdData -> it.groomerPhone },
    "trainerName" to { it: HouseholdData -> it.trainerName },
    "trainerPhone" to { it: HouseholdData -> it.trainerPhone },
    "petSitterBackup" to { it: HouseholdData -> it.petSitterBackup },
    "dogWalkerBackup" to { it: HouseholdData -> it.dogWalkerBackup },
)

/**
 * The fields [edited] changes relative to [loaded], keyed by Firestore field
 * name. Empty when nothing changed, which the caller must treat as "do not
 * write" rather than "write the stamp".
 *
 * [loaded] must be the copy Firestore handed us, never a re-read: re-reading to
 * diff would hand back exactly the concurrent edit this is protecting.
 *
 * A field cleared to blank IS a change and is written as `""`. Skipping blanks
 * would make "delete this note" the one edit the screen cannot perform.
 */
internal fun householdFieldChanges(
    loaded: HouseholdData,
    edited: HouseholdData,
): Map<String, String> {
    val changes = LinkedHashMap<String, String>()
    for ((field, read) in HOUSEHOLD_DIFF_FIELDS) {
        val next = read(edited)
        if (next != read(loaded)) changes[field] = next
    }
    return changes
}
