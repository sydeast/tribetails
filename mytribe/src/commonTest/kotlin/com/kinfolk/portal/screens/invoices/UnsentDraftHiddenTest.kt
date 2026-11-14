package com.kinfolk.portal.screens.invoices

import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.InvoiceStatus
import com.kinfolk.portal.portal.PortalApi
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1906 (operator ruling 2026-11-11): an invoice the office has not sent is not
 * listed, counted or openable for the Kinfolk.
 *
 * The server leaves drafts out of `getMyInvoices`. These pin that the app
 * holds the same line when an answer still carries one (a server on the
 * earlier rule): `PortalApi.getMyInvoices` drops it, so the list, the counts
 * and `InvoicesController.find` (the detail page and a deep link to it) never
 * see it. The web portal's twin is `InvoicesDraftHidden.test.tsx`.
 */
class UnsentDraftHiddenTest {

    private fun row(id: String, status: String, amountDue: Double): JsonObject = buildJsonObject {
        put("id", id)
        put("kinfolkId", "kin-1")
        put("total", amountDue)
        put("amountDue", amountDue)
        put("isPaid", false)
        put("status", status)
    }

    private fun answerWithADraft(): JsonObject = buildJsonObject {
        put("accountBalanceCents", 0L)
        put("open", buildJsonArray {
            add(row("inv-sent", "open", 19.5))
            add(row("inv-draft", "draft", 28.0))
            add(row("inv-quote", "quote", 40.0))
        })
        put("paid", buildJsonArray { add(row("inv-draft-2", "draft", 0.0)) })
        put("credits", buildJsonArray {})
    }

    @Test
    fun `the api drops every unsent draft and keeps everything sent`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", answerWithADraft())
        val res = PortalApi(fake).getMyInvoices("kin-1")

        assertEquals(listOf("inv-sent", "inv-quote"), res.open.map { it.id })
        assertEquals(emptyList(), res.paid.map { it.id })
        assertTrue(res.open.none { it.status == InvoiceStatus.Draft })
        assertEquals(19.5 + 40.0, res.open.sumOf { it.amountDue })
    }

    @Test
    fun `the invoices screen does not list or open a draft, even by its id`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyInvoices", answerWithADraft())
        val c = InvoicesController("kin-1", PortalApi(fake), this) {}

        c.reload()

        val data = assertNotNull(c.data)
        assertEquals(listOf("inv-sent", "inv-quote"), data.open.map { it.id })
        assertNull(c.find("inv-draft"), "a deep link to an unsent draft finds nothing to open")
        assertNull(c.find("inv-draft-2"))
        assertNotNull(c.find("inv-sent"))
        assertNull(c.error)
    }

    @Test
    fun `a refused read is still reported, not mistaken for an empty list`() = runTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyInvoices", IllegalStateException("Could not reach the server"))
        val c = InvoicesController("kin-1", PortalApi(fake), this) {}

        c.reload()

        assertNull(c.data)
        assertEquals("Could not reach the server", c.error)
    }
}
