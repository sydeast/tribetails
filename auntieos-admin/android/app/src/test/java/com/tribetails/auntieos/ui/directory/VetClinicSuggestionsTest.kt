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
    // ── parity with the web picker (operator issue #13) ──────────────────────
    @Test fun emergencyFilter_keepsOnlyFlaggedClinics() {
        val mixed = listOf(
            VetClinic(name = "Allandale Veterinary Clinic"),
            VetClinic(name = "Austin Pet ER", isEmergency = true),
            VetClinic(name = "Night Owl Animal Hospital", isEmergency = true),
        )
        assertEquals(
            listOf("Austin Pet ER", "Night Owl Animal Hospital"),
            emergencyVetClinics(mixed).map { it.name },
        )
    }
    @Test fun emergencyFilter_onACatalogWithNoneIsEmptyNotEverything() {
        assertEquals(emptyList<VetClinic>(), emergencyVetClinics(catalog))
    }
    /**
     * The pinned create button quotes the query. It must show the TRIMMED text,
     * because that is what will be sent as the clinic name.
     */
    @Test fun createLabel_quotesTheTrimmedQuery() {
        assertEquals(
            "Create \"Barton Springs\" as a new vet clinic",
            createVetClinicLabel("  Barton Springs  "),
        )
    }
    /**
     * The button is offered whenever anything is typed, INCLUDING when nothing
     * matched, which is exactly the case it exists for. Blank query only means
     * nothing has been typed yet.
     */
    @Test fun createButton_isOfferedWheneverSomethingIsTypedEvenWithZeroMatches() {
        assertTrue(shouldOfferVetClinicCreate("zzzzz", catalog))
        assertEquals(emptyList<VetClinic>(), vetClinicSuggestions("zzzzz", catalog))
        assertTrue(shouldOfferVetClinicCreate("an", catalog))
    }
    @Test fun createButton_isNotOfferedBeforeAnythingIsTyped() {
        assertTrue(!shouldOfferVetClinicCreate("", catalog))
        assertTrue(!shouldOfferVetClinicCreate("   ", catalog))
    }
}
