package com.kinfolk.portal.screens.invoices

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Lenient decode of the OPTIONAL invoice `lineItems` field ("What this covers"
 * on InvoiceDetailScreen). Until the backend deploys the field, invoices simply
 * arrive without it — decode must yield null, never throw.
 */
class InvoiceLineItemsDecodeTest {

    private fun invoiceJson(withLineItems: Boolean) = buildJsonObject {
        put("id", "1042")
        put("kinfolkId", "3")
        put("amountDue", 45.0)
        put("total", 45.0)
        put("isPaid", false)
        put("status", "open")
        if (withLineItems) {
            put("lineItems", buildJsonArray {
                add(buildJsonObject {
                    put("sessionId", "s1")
                    put("label", "Dog Walk")
                    put("dateIso", "2026-06-01")
                    put("amountCents", 4500L)
                })
                // Sparse item: every field optional server-side.
                add(buildJsonObject { put("label", "Overnight Stay") })
            })
        }
    }

    private fun stubInvoices(fake: FakeFunctionsClient, withLineItems: Boolean) {
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 0L)
            put("open", buildJsonArray { add(invoiceJson(withLineItems)) })
            put("paid", buildJsonArray {})
            put("credits", buildJsonArray {})
        })
    }

    @Test
    fun fieldAbsent_decodesToNull() = runTest {
        val fake = FakeFunctionsClient()
        stubInvoices(fake, withLineItems = false)
        val inv = PortalApi(fake).getMyInvoices("3").open.single()
        assertNull(inv.lineItems)
    }

    @Test
    fun fieldPresent_decodesItemsWithOptionalFields() = runTest {
        val fake = FakeFunctionsClient()
        stubInvoices(fake, withLineItems = true)
        val items = PortalApi(fake).getMyInvoices("3").open.single().lineItems
        assertEquals(2, items?.size)
        assertEquals("Dog Walk", items?.get(0)?.label)
        assertEquals("2026-06-01", items?.get(0)?.dateIso)
        assertEquals(4500L, items?.get(0)?.amountCents)
        assertEquals("Overnight Stay", items?.get(1)?.label)
        assertNull(items?.get(1)?.sessionId)
        assertNull(items?.get(1)?.amountCents)
    }

    @Test
    fun emptyArray_decodesToNull() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 0L)
            put("open", buildJsonArray {
                add(buildJsonObject {
                    put("id", "1")
                    put("kinfolkId", "3")
                    put("amountDue", 1.0)
                    put("total", 1.0)
                    put("isPaid", false)
                    put("status", "open")
                    put("lineItems", buildJsonArray {})
                })
            })
            put("paid", buildJsonArray {})
            put("credits", buildJsonArray {})
        })
        assertNull(PortalApi(fake).getMyInvoices("3").open.single().lineItems)
    }
}
