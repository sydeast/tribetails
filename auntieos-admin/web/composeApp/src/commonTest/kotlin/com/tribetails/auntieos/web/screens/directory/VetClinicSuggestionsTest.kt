package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.VetClinic
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class VetClinicSuggestionsTest {

    private val catalog = listOf(
        VetClinic(name = "Allandale Veterinary Clinic"),
        VetClinic(name = "Animal Care Clinic"),
        VetClinic(name = "Animal Dermatology"),
        VetClinic(name = "All Spines Chiropractic"),
        VetClinic(name = "2222 Veterinary Clinic"),
        VetClinic(name = "Banfield Pet Hospital"),
    )

    @Test fun blankQuery_returnsNothing_searchNotDump() {
        assertEquals(emptyList(), vetClinicSuggestions("", catalog))
        assertEquals(emptyList(), vetClinicSuggestions("   ", catalog))
    }

    @Test fun prefixMatchesRankBeforeSubstring() {
        // "an" prefixes "Animal …"; it is also inside "Allandale" and "Banfield".
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
        assertEquals(emptyList(), vetClinicSuggestions("zzzzz", catalog))
    }
}
