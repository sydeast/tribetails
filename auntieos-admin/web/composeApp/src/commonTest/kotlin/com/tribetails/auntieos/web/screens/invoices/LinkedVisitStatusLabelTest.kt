package com.tribetails.auntieos.web.screens.invoices

import kotlin.test.Test
import kotlin.test.assertEquals

/** #2268: the status words on an invoice's linked visit rows. */
class LinkedVisitStatusLabelTest {
    @Test
    fun everySpellingOfACancellationReadsCancelled() {
        for (status in listOf("CANCELLED", "cancelled", "CANCELED", " canceled ")) {
            assertEquals("cancelled", linkedVisitStatusLabel(status), status)
        }
    }

    @Test
    fun otherStatusesKeepTheirWords() {
        assertEquals("completed", linkedVisitStatusLabel("COMPLETED"))
        assertEquals("on my way", linkedVisitStatusLabel("ON_MY_WAY"))
    }
}
