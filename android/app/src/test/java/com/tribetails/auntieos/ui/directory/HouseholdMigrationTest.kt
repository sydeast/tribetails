package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.HouseholdData
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class HouseholdMigrationTest {
    @Test fun empty_household_lists_all_30_fields_in_catalog_order() {
        val missing = missingHouseholdFields(HouseholdData())
        assertEquals(30, missing.size)
        assertEquals("primaryVetName", missing.first().key)
        assertEquals("Primary vet name", missing.first().label)
        assertEquals("dogWalkerBackup", missing.last().key)
    }

    @Test fun fully_filled_household_has_no_missing_fields() {
        val full = HouseholdData(
            primaryVetName = "a", primaryVetPhone = "a", primaryVetAddress = "a", primaryVetHours = "a",
            emergencyVetName = "a", emergencyVetPhone = "a", emergencyVetAddress = "a",
            foodLocation = "a", treatLocation = "a", medicationLocation = "a", toysLocation = "a",
            beddingLocation = "a", leashesPoopBagsLocation = "a", cleaningSuppliesLocation = "a",
            householdRules = "a", preferredWalkRoutes = "a", neighborhoodHazards = "a",
            securitySystemInfo = "a", thermostatInstructions = "a", lightingPreferences = "a",
            poisonControlNumber = "a", emergencyContactsPriority = "a", evacuationPlan = "a",
            importantDocumentsLocation = "a", groomerName = "a", groomerPhone = "a",
            trainerName = "a", trainerPhone = "a", petSitterBackup = "a", dogWalkerBackup = "a",
        )
        assertTrue(missingHouseholdFields(full).isEmpty())
    }

    @Test fun partial_household_returns_only_blanks_in_order() {
        val partial = HouseholdData(primaryVetName = "Dr Vet", foodLocation = "pantry")
        val missing = missingHouseholdFields(partial)
        assertTrue(missing.none { it.key == "primaryVetName" })
        assertTrue(missing.none { it.key == "foodLocation" })
        assertEquals("primaryVetPhone", missing.first().key)
        assertEquals(28, missing.size)
    }

    @Test fun whitespace_only_counts_as_missing() {
        assertTrue(missingHouseholdFields(HouseholdData(primaryVetName = "   ")).any { it.key == "primaryVetName" })
    }
}
