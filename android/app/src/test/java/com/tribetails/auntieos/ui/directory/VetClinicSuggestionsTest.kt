package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.VetClinic
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VetClinicSuggestionsTest {

    private val catalog = listOf(
        VetClinic(name = "Allandale Veterinary Clinic"),
        VetClinic(name = "Animal Care Clinic"),
        VetClinic(name = "Animal Dermatology"),
        VetClinic(name = "All Spines Chiropractic"),
        VetClinic(name = "2222 Veterinary Clinic"),
        VetClinic(name = "Banfield Pet Hospital"),
    )

    @Test fun blankQuery_returnsNothing() {
        assertEquals(emptyList<VetClinic>(), vetClinicSuggestions("", catalog))
        assertEquals(emptyList<VetClinic>(), vetClinicSuggestions("   ", catalog))
    }

    @Test fun prefixMatchesRankBeforeSubstring() {
        val out = vetClinicSuggestions("an", catalog).map { it.name }
        assertEquals("Animal Care Clinic", out[0])
        assertEquals("Animal Dermatology", out[1])
        assertTrue(out.contains("Allandale Veterinary Clinic"))
        assertTrue(out.contains("Banfield Pet Hospital"))
    }

    @Test fun caseInsensitiveContains() {
        assertEquals(
            listOf("All Spines Chiropractic"),
            vetClinicSuggestions("SPINES", catalog).map { it.name },
        )
    }

    @Test fun respectsLimit() {
        val many = (1..50).map { VetClinic(name = "Clinic $it") }
        assertEquals(8, vetClinicSuggestions("clinic", many).size)
        assertEquals(3, vetClinicSuggestions("clinic", many, limit = 3).size)
    }

    @Test fun noMatch_isEmpty() {
        assertEquals(emptyList<VetClinic>(), vetClinicSuggestions("zzzzz", catalog))
    }
}
