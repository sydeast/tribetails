package com.tribetails.auntieos.ui.kintales

import com.tribetails.auntieos.data.model.Kin
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pure-helper tests for [kinHeading] (spec 11 item 4.1), mirroring the web
 * KinHeadingTest: per-kin headings join real name/species/breed, drop blanks, and
 * fall back to the raw id rather than fabricate a pet name.
 */
class KinHeadingTest {

    private fun kin(id: String, name: String, species: String = "Dog", breed: String = "") =
        Kin(id = id, name = name, species = species, breed = breed)

    @Test
    fun joinsNameSpeciesBreed() {
        assertEquals("Biscuit · Dog · Labrador", kinHeading(kin("k1", "Biscuit", "Dog", "Labrador")))
    }

    @Test
    fun dropsBlankBreed() {
        assertEquals("Gravy · Cat", kinHeading(kin("k1", "Gravy", "Cat", "")))
    }

    @Test
    fun dropsBlankSpeciesAndBreed() {
        assertEquals("Marigold", kinHeading(kin("k1", "Marigold", "", "")))
    }

    @Test
    fun fallsBackToIdWhenNameBlank() {
        assertEquals("k1", kinHeading(kin("k1", name = "", species = "Dog", breed = "Poodle")))
    }
}
