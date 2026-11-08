package com.tribetails.auntieos.web.screens

import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.KinCareVisit
import com.tribetails.auntieos.web.data.UninvoicedSession
import com.tribetails.auntieos.web.screens.booking.groupIncomingBySeries
import com.tribetails.auntieos.web.screens.booking.serviceName
import com.tribetails.auntieos.web.screens.booking.subject
import com.tribetails.auntieos.web.screens.invoices.composerMoney
import com.tribetails.auntieos.web.screens.invoices.linkPickerChipLabel
import com.tribetails.auntieos.web.screens.invoices.linkedSessionServiceLabel
import com.tribetails.auntieos.web.screens.invoices.visitLineDescription
import com.tribetails.auntieos.web.screens.sessions.heroTitle
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #1744: the invoice, Auntie Time and booking-request surfaces name a visit's
 * service by its KinCare, the web `bookingServiceName` rule. "Long walk" runs
 * 45 minutes, so a stored `visit_45` reads as "Long walk".
 */
class ServiceNames1744Test {
    private val catalog = ServiceCatalog(mapOf("Long walk" to "45"), mapOf("Long walk" to "45"))
    private val stored = UninvoicedSession("s1", "kf1", "visit_45", 45.0, "2026-10-02T15:00:00.000Z", 2500L)

    @Test
    fun anInvoiceLineNamesTheKinCareTheHouseholdReads() {
        assertEquals("Long walk, 2026-10-02", visitLineDescription(stored, catalog))
        val money = composerMoney(listOf(stored), setOf("s1"), emptyMap(), emptyList(), "", catalog)
        assertEquals("Long walk, 2026-10-02", money.lines?.single()?.description)
    }

    @Test
    fun theLinkedVisitsAndTheLinkPickerNameTheKinCare() {
        assertEquals("Long walk", linkedSessionServiceLabel("visit_45", catalog))
        assertEquals("Service", linkedSessionServiceLabel("", catalog))
        assertEquals(
            "Long walk · 2026-10-02 · on another invoice",
            linkPickerChipLabel("visit_45", "2026-10-02", elsewhere = true, cancelled = false, catalog = catalog),
        )
        assertEquals(
            "Session · 2026-10-02 · cancelled, not billable",
            linkPickerChipLabel("", "2026-10-02", elsewhere = false, cancelled = true, catalog = catalog),
        )
    }

    @Test
    fun theVisitDetailTitleNamesTheKinCare() {
        assertEquals("The Wrens · Long walk", heroTitle(KinCareSession(kinfolkName = "The Wrens", serviceType = "visit_45"), catalog))
        assertEquals("The Wrens", heroTitle(KinCareSession(kinfolkName = "The Wrens", serviceType = ""), catalog))
    }

    @Test
    fun anIncomingRequestNamesTheKinCare() {
        val series = groupIncomingBySeries(
            listOf(
                KinCareVisit(
                    _id = "v1",
                    path = "families/kf1/bookings/b1/kinCares/v1",
                    startTime = "2026-06-03T14:00:00Z",
                    serviceType = "visit_45",
                ),
            ),
        ).single()
        assertEquals("Long walk", series.serviceName(catalog))
        assertEquals("1 visit · Long walk", series.subject(catalog))
    }
}
