package com.tribetails.auntieos.web.screens.sessions

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** #1602: "18605" reached the visit and the Auntie Time chip with no hint. */
class AddressCompletenessTest {
    @Test
    fun flagsABareNumberOrAStreetWithNoTown() {
        assertTrue(addressLooksIncomplete("18605"))
        assertTrue(addressLooksIncomplete("Main St"))
    }

    @Test
    fun acceptsAFullAddressAndSaysNothingAboutABlankOne() {
        assertFalse(addressLooksIncomplete("18605 Oak Lane, Austin TX"))
        assertFalse(addressLooksIncomplete("18605 Oak Lane Austin"))
        assertFalse(addressLooksIncomplete(""))
    }
}
