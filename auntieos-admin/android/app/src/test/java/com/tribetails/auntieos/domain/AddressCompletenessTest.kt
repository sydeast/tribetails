package com.tribetails.auntieos.domain

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** #1602: "18605" reached the visit and the Auntie Time chip with no hint. Mirrors the web test. */
class AddressCompletenessTest {

    @Test
    fun flagsABareNumberOrZip() {
        assertTrue(addressLooksIncomplete("18605"))
        assertTrue(addressLooksIncomplete("  78701 "))
    }

    @Test
    fun flagsAStreetWithNoNumberAndNoTown() {
        assertTrue(addressLooksIncomplete("Main St"))
    }

    @Test
    fun acceptsAStreetWithATown() {
        assertFalse(addressLooksIncomplete("18605 Oak Lane, Austin TX"))
        assertFalse(addressLooksIncomplete("12 Rue Cler, Paris"))
        assertFalse(addressLooksIncomplete("18605 Oak Lane Austin"))
    }

    @Test
    fun saysNothingAboutABlankAddress() {
        assertFalse(addressLooksIncomplete("   "))
    }
}
