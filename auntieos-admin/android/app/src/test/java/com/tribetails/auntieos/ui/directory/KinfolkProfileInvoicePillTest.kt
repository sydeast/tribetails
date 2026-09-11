package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The invoice capsule on the household profile's Invoices panel (#755).
 *
 * The mock draws a two-value Paid/Unpaid pill. The app's invoices carry eight
 * stamped states, and collapsing them to two would print "Paid" on a
 * cancelled bill and on a quote nobody has answered, so the capsule carries
 * the state the server stamped, in the tone the web feed's `invoicePillTone`
 * gives it: paid teal, open orange, a quote purple, the rest muted. A doc with
 * no recognizable stamp shows its raw stored string rather than being
 * re-classified off the money.
 */
class KinfolkProfileInvoicePillTest {

    @Test
    fun `a paid invoice is a teal Paid capsule and an open one an orange Unpaid`() {
        assertEquals("Paid" to AuntieStatusTone.Teal, invoiceFeedPill(Invoice(status = "paid")))
        assertEquals("Unpaid" to AuntieStatusTone.Orange, invoiceFeedPill(Invoice(status = "open", amountDue = 40.0)))
    }

    @Test
    fun `a cancelled bill and a quote are never dressed up as paid`() {
        assertEquals("Cancelled" to AuntieStatusTone.Muted, invoiceFeedPill(Invoice(status = "cancelled")))
        assertEquals("Quote" to AuntieStatusTone.Purple, invoiceFeedPill(Invoice(status = "quote")))
    }

    @Test
    fun `an unstamped legacy doc reads as what it says, not as a guess off the money`() {
        assertEquals("Sent" to AuntieStatusTone.Muted, invoiceFeedPill(Invoice(status = "Sent", amountDue = 0.0)))
        assertEquals("No status" to AuntieStatusTone.Muted, invoiceFeedPill(Invoice(status = "  ")))
    }
}
