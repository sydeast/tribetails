package com.tribetails.auntieos.web.screens.settings

import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.VetClinic
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #6 (2026-06-08): pure helpers for the redesigned vet-clinics grid, the
 * household-count badge and the logo monogram.
 */
class VetClinicGridHelpersTest {

    private val creekside = VetClinic(_id = "c1", name = "Creekside Animal Hospital")

    @Test fun `household count matches kinfolk by trimmed case-insensitive name`() {
        val kinfolk = listOf(
            Kinfolk(vetClinicName = "Creekside Animal Hospital"),
            Kinfolk(vetClinicName = "  creekside animal hospital "), // trimmed + case-insensitive
            Kinfolk(vetClinicName = "Other Vet"),
            Kinfolk(vetClinicName = ""),
        )
        assertEquals(2, vetClinicHouseholdCount(creekside, kinfolk))
    }

    @Test fun `household count is zero for a blank clinic name`() {
        val kinfolk = listOf(Kinfolk(vetClinicName = ""), Kinfolk(vetClinicName = "X"))
        assertEquals(0, vetClinicHouseholdCount(VetClinic(name = "   "), kinfolk))
    }

    @Test fun `monogram takes the first letters of up to two words`() {
        assertEquals("CA", vetClinicMonogram("Creekside Animal Hospital"))
        assertEquals("PA", vetClinicMonogram("Paws"))    // single word -> first two letters
        assertEquals("?", vetClinicMonogram("   "))
    }
}
