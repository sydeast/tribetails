package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.FirestoreClient
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * #1871: after Save changes the console sheet shows the invoice as read back
 * from the server, not the polled copy from before the edit.
 */
class InvoiceShownAfterEditTest {
    private val before = Invoice(_id = "inv1", total = 25.0, amountDue = 25.0)
    private val after = before.copy(total = 1025.0, amountDue = 1025.0)

    @AfterTest
    fun reset() {
        JvmFirestoreFixtures.invoices = null
    }

    @Test
    fun `while the stream still holds the pre-edit copy, the saved copy is shown`() {
        assertEquals(1025.0, invoiceShownAfterEdit(before, SavedInvoiceEdit(before, after)).total)
    }

    @Test
    fun `once the stream moves on it wins, edit or a later change`() {
        val later = after.copy(amountDue = 0.0)
        assertEquals(after, invoiceShownAfterEdit(after, SavedInvoiceEdit(before, after)))
        assertEquals(later, invoiceShownAfterEdit(later, SavedInvoiceEdit(before, after)))
    }

    @Test
    fun `no saved edit, or one for another invoice, leaves the stream alone`() {
        assertEquals(before, invoiceShownAfterEdit(before, null))
        val other = before.copy(_id = "inv2")
        assertEquals(other, invoiceShownAfterEdit(other, SavedInvoiceEdit(other.copy(total = 1.0), after)))
        assertEquals(other, invoiceShownAfterEdit(other, SavedInvoiceEdit(other, after)))
    }

    @Test
    fun `the read back returns the stored invoice, or null when it is gone`() = runBlocking {
        JvmFirestoreFixtures.invoices = listOf(after)
        assertEquals(1025.0, FirestoreClient().invoiceFromServer("inv1")?.total)
        assertNull(FirestoreClient().invoiceFromServer("missing"))
    }
}
