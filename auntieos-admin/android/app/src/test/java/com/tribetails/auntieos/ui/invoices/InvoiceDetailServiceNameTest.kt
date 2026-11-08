package com.tribetails.auntieos.ui.invoices

import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.ui.admin.ServiceCatalog
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * #1744: the invoice's linked visits and the link picker name each visit by its
 * KinCare, the web `InvoiceLedger` and `InvoiceLinkVisitsEditor` rule.
 */
class InvoiceDetailServiceNameTest {
    /** "Long walk" runs 45 minutes, so a stored `visit_45` reads as "Long walk". */
    private val catalog = ServiceCatalog(mapOf("Long walk" to "45"), mapOf("Long walk" to "45"))
    private val session = KinCareSession(id = "s1", serviceType = "visit_45")

    @Test fun `a linked visit row names the KinCare, never the stored key`() {
        assertEquals("Long walk", linkedSessionServiceLabel(session, catalog))
        assertEquals("Service", linkedSessionServiceLabel(session.copy(serviceType = ""), catalog))
    }

    @Test fun `a link picker chip names the KinCare and keeps why it cannot be ticked`() {
        assertEquals(
            "Long walk · 2026-07-10 · on another invoice",
            linkPickerChipLabel(session, "2026-07-10", elsewhere = true, cancelled = false, catalog = catalog),
        )
        assertEquals(
            "Session · 2026-07-10 · cancelled, not billable",
            linkPickerChipLabel(session.copy(serviceType = ""), "2026-07-10", elsewhere = false, cancelled = true, catalog = catalog),
        )
    }
}
