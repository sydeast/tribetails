package com.tribetails.auntieos.web.util

import kotlin.test.Test
import kotlin.test.assertEquals

class HouseholdsTest {

    @Test
    fun plain_names_get_a_single_s() {
        assertEquals("the Halbrooks", householdLabel("Halbrook"))
        assertEquals("the Thornes", householdLabel("Thorne"))
        assertEquals("the Demos", householdLabel("Demo"))
        assertEquals("the Bs", householdLabel("B"))
    }

    @Test
    fun names_ending_in_y_get_s_not_ies() {
        // Surnames don't follow the noun y->ies rule: "the Kennedys", not "Kennedies".
        assertEquals("the Kennedys", householdLabel("Kennedy"))
    }

    @Test
    fun sibilant_endings_get_es_no_doubling() {
        assertEquals("the Brookses", householdLabel("Brooks"))  // was "the Brookss"
        assertEquals("the Joneses", householdLabel("Jones"))
        assertEquals("the Marxes", householdLabel("Marx"))
        assertEquals("the Sanchezes", householdLabel("Sanchez"))
        assertEquals("the Finches", householdLabel("Finch"))
        assertEquals("the Walshes", householdLabel("Walsh"))
    }

    @Test
    fun case_insensitive_ending_detection() {
        assertEquals("the SEEDSes", householdLabel("SEEDS"))
    }

    @Test
    fun blank_returns_empty() {
        assertEquals("", householdLabel(""))
        assertEquals("", householdLabel("   "))
    }
}
