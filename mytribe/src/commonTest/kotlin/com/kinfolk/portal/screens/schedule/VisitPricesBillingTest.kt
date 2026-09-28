package com.kinfolk.portal.screens.schedule
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.Service
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
/**
 * #1037, D-2026-09-28-VISIT-PRICES-ARE-BILLING: "visit prices are billing
 * information; hide them from members without billing access." The server
 * strips the price keys and answers `pricesVisible: false`; the wizard then
 * draws no price label and no estimate row. Android and desktop share this
 * code, so these run on both through `:jvmTest`.
 */
class VisitPricesBillingTest {
    private fun strippedCatalog(pricesVisible: Boolean?) = buildJsonObject {
        put("services", buildJsonArray {
            add(buildJsonObject {
                put("id", "30Minute")
                put("name", "30 Minute")
                put("isOvernight", false)
            })
        })
        if (pricesVisible != null) put("pricesVisible", pricesVisible)
    }
    @Test
    fun `getServiceCatalog sends the active tribe, and nothing without one`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getServiceCatalog", strippedCatalog(true))
        PortalApi(fake).getServiceCatalog("fam1")
        assertEquals("fam1", fake.calls.last().second?.get("kinfolkId")?.jsonPrimitive?.content)
        PortalApi(fake).getServiceCatalog()
        assertNull(fake.calls.last().second)
    }
    @Test
    fun `a stripped catalog decodes with no prices and pricesVisible false`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getServiceCatalog", strippedCatalog(false))
        val res = PortalApi(fake).getServiceCatalog("fam1")
        assertEquals(false, res.pricesVisible)
        val s = res.services.single()
        assertEquals("30 Minute", s.name)
        assertNull(s.priceCents)
        assertNull(s.priceMinCents)
        assertNull(s.priceMaxCents)
    }
    @Test
    fun `a missing pricesVisible is an older server and reads as true`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getServiceCatalog", strippedCatalog(null))
        assertEquals(true, PortalApi(fake).getServiceCatalog("fam1").pricesVisible)
    }
    @Test
    fun `priceLabel prints nothing for a service with no price, never a zero`() {
        val s = Service(
            id = "30Minute", name = "30 Minute", category = null, description = null,
            priceCents = null, priceMinCents = null, priceMaxCents = null,
            isOvernight = true, iconKey = null,
        )
        assertEquals("", priceLabel(s))
        assertEquals("$42.00", priceLabel(s.copy(priceCents = 4200L, isOvernight = false)))
    }
    @Test
    fun `the Review estimate row is dropped without billing access, and kept with it`() {
        val service = Service(
            id = "s1", name = "Daily Visit", category = null, description = null,
            priceCents = 4200L, priceMinCents = null, priceMaxCents = null,
            isOvernight = false, iconKey = null,
        )
        val stripped = service.copy(priceCents = null)
        val visit = com.kinfolk.portal.portal.BookingVisit(
            startTimeMs = 1_900_000_000_000L,
            endTimeMs = null,
            serviceId = "s1",
            serviceName = "Daily Visit",
            priceCents = null,
        )
        // Without billing the catalog is stripped, so the raw estimate would be
        // "Pending". The row must not be drawn at all.
        assertEquals("Pending", formatEstimate(estimateBookingTotal(listOf(visit), listOf(stripped))))
        assertNull(estimateRowLabel(false, estimateBookingTotal(listOf(visit), listOf(stripped))))
        assertEquals("$42.00", estimateRowLabel(true, estimateBookingTotal(listOf(visit), listOf(service))))
    }
}
