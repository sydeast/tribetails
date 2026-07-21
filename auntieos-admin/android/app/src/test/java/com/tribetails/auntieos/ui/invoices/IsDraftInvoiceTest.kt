package com.tribetails.auntieos.ui.invoices

import com.tribetails.auntieos.data.model.Invoice
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Stage 2 tail: the draft determination that gates the Review-and-send affordance on
 * the invoice detail. Case- and whitespace-tolerant so a "Draft" / " DRAFT " value
 * still resolves; anything else (sent, paid, blank) is not a draft.
 */
class IsDraftInvoiceTest {

    @Test fun `DRAFT status is a draft regardless of case or padding`() {
        assertTrue(isDraftInvoice(Invoice(status = "DRAFT")))
        assertTrue(isDraftInvoice(Invoice(status = "draft")))
        assertTrue(isDraftInvoice(Invoice(status = " Draft ")))
    }

    @Test fun `non-draft statuses are not drafts`() {
        assertFalse(isDraftInvoice(Invoice(status = "sent")))
        assertFalse(isDraftInvoice(Invoice(status = "paid")))
        assertFalse(isDraftInvoice(Invoice(status = "")))
    }
}
