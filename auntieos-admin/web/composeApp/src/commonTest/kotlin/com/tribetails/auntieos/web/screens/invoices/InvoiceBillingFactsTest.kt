package com.tribetails.auntieos.web.screens.invoices

import kotlin.test.Test
import kotlin.test.assertEquals

/** #1899: the saved name, address and discount note show on the invoice. */
class InvoiceBillingFactsTest {
    @Test fun `nothing shows when none is set`() {
        assertEquals(emptyList<Pair<String, String>>(), invoiceBillingFacts("Dre East", "", " ", ""))
    }

    @Test fun `a saved name, address and discount note list in order`() {
        assertEquals(
            listOf("Kinfolk" to "Sam Lee", "Address" to "12 Oak St", "Discount note" to "Neighbor rate"),
            invoiceBillingFacts("Dre East", "Sam Lee", " 12 Oak St ", "Neighbor rate"),
        )
    }

    @Test fun `a name that only repeats the household is left out`() {
        assertEquals(emptyList<Pair<String, String>>(), invoiceBillingFacts("Dre East", " dre east ", "", ""))
    }
}
