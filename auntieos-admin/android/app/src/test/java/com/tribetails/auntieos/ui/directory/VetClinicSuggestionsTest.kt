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
    // ── committed selection (no free text, parity with web) ──────────────────
    @Test fun selectionOfACatalogClinic_stampsTheIdAndDenormalizesTheRest() {
        val clinic = VetClinic(
            id = "riverside",
            name = "  Riverside Animal Hospital  ",
            phone = " (512) 555-0100 ",
            address = " 1 Mill St ",
        )
        val sel = vetClinicSelectionOf(clinic)
        assertEquals("riverside", sel.clinicId)
        assertEquals("Riverside Animal Hospital", sel.name)
        assertEquals("(512) 555-0100", sel.phone)
        assertEquals("1 Mill St", sel.address)
        assertTrue(sel.hasSelection)
        assertTrue(!sel.unlinked)
    }
    @Test fun emptySelection_hasNothingAndIsNotUnlinked() {
        val sel = EMPTY_VET_CLINIC_SELECTION
        assertTrue(!sel.hasSelection)
        assertTrue(!sel.unlinked)
        assertEquals("", sel.detail)
    }
    /**
     * Every household written before the picker holds the strings and NO id.
     * That is a valid, renderable selection, not a broken one.
     */
    @Test fun legacySelection_isAValidSelectionMarkedUnlinked() {
        val sel = VetClinicSelection(name = "Old Corner Vet", phone = "512-555-0000")
        assertTrue(sel.hasSelection)
        assertTrue(sel.unlinked)
        assertEquals("512-555-0000", sel.detail)
    }
    @Test fun detail_joinsPhoneAndAddressAndSkipsWhicheverIsMissing() {
        assertEquals(
            "(512) 555-0100 · 1 Mill St",
            VetClinicSelection(clinicId = "c", name = "N", phone = "(512) 555-0100", address = "1 Mill St").detail,
        )
        assertEquals("1 Mill St", VetClinicSelection(clinicId = "c", name = "N", address = "1 Mill St").detail)
        assertEquals("", VetClinicSelection(clinicId = "c", name = "N").detail)
    }
}
/**
 * Punchlist B4: a retired clinic stops being OFFERED, without a household
 * already on it losing anything.
 */
class VetClinicSuggestionsArchivedTest {
    private val live = VetClinic(id = "a", name = "Riverside Animal Hospital")
    private val retired = VetClinic(id = "b", name = "Riverside Closed Branch", archived = true)
    @Test fun archivedClinicsAreNotOffered() {
        val hits = vetClinicSuggestions("riverside", listOf(live, retired))
        assertEquals(listOf("a"), hits.map { it.id })
    }
    @Test fun anAllArchivedCatalogSuggestsNothing() {
        assertTrue(vetClinicSuggestions("riverside", listOf(retired)).isEmpty())
    }
    /**
     * The household's own record is untouched by archiving: it keeps the
     * denormalized name, phone and address, so what is ON FILE still renders.
     * Only picking a NEW one is affected, which is what retiring is for.
     */
    @Test fun aSelectionOnAnArchivedClinicStillRenders() {
        val sel = VetClinicSelection(clinicId = "b", name = "Riverside Closed Branch", phone = "555")
        assertTrue(sel.hasSelection)
        assertEquals("555", sel.detail)
    }
}
