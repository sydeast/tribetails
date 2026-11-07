package com.tribetails.auntieos.web.screens.directory

import kotlin.test.Test
import kotlin.test.assertEquals

/** #1602: two kin named Mia could not be told apart; the card names the household. */
class KinCardFooterTest {
    @Test
    fun namesTheHouseholdThenTheSex() {
        assertEquals("Dre East · Female", kinCardFooter("Dre East", "Female"))
    }

    @Test
    fun eitherPartMayBeBlank() {
        assertEquals("Dre East", kinCardFooter("Dre East", ""))
        assertEquals("Female", kinCardFooter("  ", "Female"))
        assertEquals("", kinCardFooter("", ""))
    }
}
