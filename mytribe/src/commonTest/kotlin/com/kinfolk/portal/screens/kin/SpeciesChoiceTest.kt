package com.kinfolk.portal.screens.kin
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
/** Which species radio a stored value lands on (AddEditKinDialog species picker). */
class SpeciesChoiceTest {
    @Test
    fun listedSpeciesMatchesIgnoringCaseAndPadding() {
        assertEquals("Dog", speciesChoice("dog"))
        assertEquals("Cat", speciesChoice("  CAT "))
        assertEquals("Small Animal", speciesChoice("small animal"))
    }
    @Test
    fun aLegacyOrUnlistedSpeciesOpensOnOtherSoItsTextSurvives() {
        assertEquals(SPECIES_OTHER, speciesChoice("Ferret"))
        assertEquals(SPECIES_OTHER, speciesChoice("Dgo"))
    }
    @Test
    fun blankIsUnset() {
        assertNull(speciesChoice(""))
        assertNull(speciesChoice("   "))
    }
}
