package com.tribetails.auntieos.web.screens.kintales

import com.tribetails.auntieos.web.data.Kin
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Pure-helper tests for [kinHeading] (spec 11 item 4.1): the per-kin checklist
 * heading must join real name/species/breed, drop blanks, and fall back to the
 * raw id rather than fabricate a pet name when the kin can't be resolved.
 */
class KinHeadingTest {

    private fun kin(id: String, name: String, species: String = "Dog", breed: String = "") =
        Kin(_id = id, name = name, species = species, breed = breed)

    @Test
    fun joinsNameSpeciesBreed() {
        val map = mapOf("k1" to kin("k1", "Biscuit", species = "Dog", breed = "Labrador"))
        assertEquals("Biscuit · Dog · Labrador", kinHeading("k1", map))
    }

    @Test
    fun dropsBlankBreed() {
        val map = mapOf("k1" to kin("k1", "Gravy", species = "Cat", breed = ""))
        assertEquals("Gravy · Cat", kinHeading("k1", map))
    }

    @Test
    fun dropsBlankSpeciesAndBreed() {
        val map = mapOf("k1" to kin("k1", "Marigold", species = "", breed = ""))
        assertEquals("Marigold", kinHeading("k1", map))
    }

    @Test
    fun fallsBackToIdWhenKinMissing() {
        // No join available (e.g. empty kin stream): show the id, never invent a name.
        assertEquals("k-unknown", kinHeading("k-unknown", emptyMap()))
    }

    @Test
    fun fallsBackToIdWhenNameBlank() {
        val map = mapOf("k1" to kin("k1", name = "", species = "Dog", breed = "Poodle"))
        assertEquals("k1", kinHeading("k1", map))
    }
}
