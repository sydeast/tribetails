package com.tribetails.auntieos.ui.invoices

import org.junit.Assert.assertEquals
import org.junit.Test

/** #2268: the status words on an invoice's linked visit rows. */
class LinkedVisitStatusLabelTest {
    @Test
    fun everySpellingOfACancellationReadsCancelled() {
        for (status in listOf("CANCELLED", "cancelled", "CANCELED", " canceled ")) {
            assertEquals(status, "cancelled", linkedVisitStatusLabel(status))
        }
    }

    @Test
    fun otherStatusesKeepTheirWords() {
        assertEquals("completed", linkedVisitStatusLabel("COMPLETED"))
        assertEquals("on my way", linkedVisitStatusLabel("ON_MY_WAY"))
    }
}
