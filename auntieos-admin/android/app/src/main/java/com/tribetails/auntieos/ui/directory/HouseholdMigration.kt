package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.HouseholdData

/** A structured HouseholdData field that is still empty (for the migration gap list). */
data class MissingHouseholdField(val key: String, val label: String)

private class HField(val key: String, val label: String, val get: (HouseholdData) -> String)

// Canonical ordered catalog of the 30 content fields (excludes _id/kinfolkId/createdAt/updatedAt).
// Owned by the helper so the gap list is identical across web + android.
private val HOUSEHOLD_FIELDS: List<HField> = listOf(
    HField("primaryVetName", "Primary vet name") { it.primaryVetName },
    HField("primaryVetPhone", "Primary vet phone") { it.primaryVetPhone },
    HField("primaryVetAddress", "Primary vet address") { it.primaryVetAddress },
    HField("primaryVetHours", "Primary vet hours") { it.primaryVetHours },
    HField("emergencyVetName", "Emergency vet name") { it.emergencyVetName },
    HField("emergencyVetPhone", "Emergency vet phone") { it.emergencyVetPhone },
    HField("emergencyVetAddress", "Emergency vet address") { it.emergencyVetAddress },
    HField("foodLocation", "Food location") { it.foodLocation },
    HField("treatLocation", "Treat location") { it.treatLocation },
    HField("medicationLocation", "Medication location") { it.medicationLocation },
    HField("toysLocation", "Toys location") { it.toysLocation },
    HField("beddingLocation", "Bedding location") { it.beddingLocation },
    HField("leashesPoopBagsLocation", "Leashes & poop bags location") { it.leashesPoopBagsLocation },
    HField("cleaningSuppliesLocation", "Cleaning supplies location") { it.cleaningSuppliesLocation },
    HField("householdRules", "Household rules") { it.householdRules },
    HField("preferredWalkRoutes", "Preferred walk routes") { it.preferredWalkRoutes },
    HField("neighborhoodHazards", "Neighborhood hazards") { it.neighborhoodHazards },
    HField("securitySystemInfo", "Security system info") { it.securitySystemInfo },
    HField("thermostatInstructions", "Thermostat instructions") { it.thermostatInstructions },
    HField("lightingPreferences", "Lighting preferences") { it.lightingPreferences },
    HField("poisonControlNumber", "Poison control number") { it.poisonControlNumber },
    HField("emergencyContactsPriority", "Emergency contacts priority") { it.emergencyContactsPriority },
    HField("evacuationPlan", "Evacuation plan") { it.evacuationPlan },
    HField("importantDocumentsLocation", "Important documents location") { it.importantDocumentsLocation },
    HField("groomerName", "Groomer name") { it.groomerName },
    HField("groomerPhone", "Groomer phone") { it.groomerPhone },
    HField("trainerName", "Trainer name") { it.trainerName },
    HField("trainerPhone", "Trainer phone") { it.trainerPhone },
    HField("petSitterBackup", "Backup pet sitter") { it.petSitterBackup },
    HField("dogWalkerBackup", "Backup dog walker") { it.dogWalkerBackup },
)

/**
 * The seven free-text vet fields, retired as an authoring surface by punchlist
 * A2. Still read, still shown when populated, never written.
 *
 * They stay in the catalog above so the gap list keeps its shape, but they are
 * named here so the veterinary card can surface any value still on file rather
 * than silently dropping it. The migration
 * (`mytribe/scripts/backfillHouseholdVetToKinfolk.ts`) moves exactly these.
 */
private val LEGACY_VET_KEYS = setOf(
    "primaryVetName", "primaryVetPhone", "primaryVetAddress", "primaryVetHours",
    "emergencyVetName", "emergencyVetPhone", "emergencyVetAddress",
)

/** The retired vet fields still carrying a value, as (label, value) pairs. */
fun legacyVetLeftovers(household: HouseholdData): List<Pair<String, String>> =
    HOUSEHOLD_FIELDS
        .filter { it.key in LEGACY_VET_KEYS && it.get(household).isNotBlank() }
        .map { it.label to it.get(household) }

/** The empty HouseholdData fields (key+label), in canonical order, for the migration gap list. */
fun missingHouseholdFields(household: HouseholdData): List<MissingHouseholdField> =
    HOUSEHOLD_FIELDS.filter { it.get(household).isBlank() }
        .map { MissingHouseholdField(it.key, it.label) }

/** True when a field key is still empty, used to flag fields in the household editor. */
fun isHouseholdFieldMissing(household: HouseholdData, key: String): Boolean =
    missingHouseholdFields(household).any { it.key == key }
