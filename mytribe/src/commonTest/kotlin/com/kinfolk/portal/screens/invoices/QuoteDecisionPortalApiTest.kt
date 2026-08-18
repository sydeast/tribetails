package com.kinfolk.portal.screens.invoices
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.InvoiceStatus
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.QuoteDecision
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
 * The quote half of the invoice payload, and the two callables that answer it
 * (issue #385).
 *
 * The first test is the one that would have caught the client half of the bug:
 * a `quote` status used to fall through this decoder's `else` branch to `Open`,
 * so the Android portal showed a proposal as a pending bill and put a Pay
 * button on it.
 */
class QuoteDecisionPortalApiTest {
    private fun invoiceJson(
        status: String,
        decision: String? = null,
        decidedAtMs: Long? = null,
    ) = buildJsonObject {
        put("id", "q1")
        put("kinfolkId", "3")
        put("amountDue", 240.0)
        put("total", 240.0)
        put("isPaid", false)
        put("status", status)
        decision?.let { put("quoteDecision", it) }
        decidedAtMs?.let { put("quoteDecidedAtMs", it) }
    }
    private fun stubInvoices(fake: FakeFunctionsClient, invoice: kotlinx.serialization.json.JsonObject) {
        fake.stub("getMyInvoices", buildJsonObject {
            put("accountBalanceCents", 0L)
            put("open", buildJsonArray { add(invoice) })
            put("paid", buildJsonArray {})
            put("credits", buildJsonArray {})
        })
    }
    @Test
    fun quoteStatus_decodesAsAQuote_notAsAnOpenBill() = runTest {
        val fake = FakeFunctionsClient()
        stubInvoices(fake, invoiceJson("quote"))
        val inv = PortalApi(fake).getMyInvoices("3").open.single()
        assertEquals(InvoiceStatus.Quote, inv.status)
        assertNull(inv.quoteDecision)
    }
    @Test
    fun decisionFields_decodeWhenPresent() = runTest {
        val fake = FakeFunctionsClient()
        stubInvoices(fake, invoiceJson("quote", "denied", 1_755_000_000_000L))
        val inv = PortalApi(fake).getMyInvoices("3").open.single()
        assertEquals(QuoteDecision.Denied, inv.quoteDecision)
        assertEquals(1_755_000_000_000L, inv.quoteDecidedAtMs)
    }
    @Test
    fun unknownDecision_readsAsNoAnswerRatherThanThrowing() = runTest {
        val fake = FakeFunctionsClient()
        stubInvoices(fake, invoiceJson("quote", "maybe"))
        val inv = PortalApi(fake).getMyInvoices("3").open.single()
        assertNull(inv.quoteDecision)
    }
    @Test
    fun acceptQuote_sendsTheInvoiceAndHouseholdAndReadsBackTheStampedState() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("acceptQuote", buildJsonObject {
            put("ok", true)
            put("invoiceId", "q1")
            put("status", "open")
        })
        val res = PortalApi(fake).acceptQuote(invoiceId = "q1", kinfolkId = "3")
        assertEquals(true, res.ok)
        assertEquals("q1", res.invoiceId)
        // Accepting turns the quote into a bill, and the state says so.
        assertEquals(InvoiceStatus.Open, res.status)
        val (name, payload) = fake.calls.single()
        assertEquals("acceptQuote", name)
        assertEquals("q1", payload?.get("invoiceId")?.jsonPrimitive?.content)
        assertEquals("3", payload?.get("kinfolkId")?.jsonPrimitive?.content)
    }
    @Test
    fun denyQuote_leavesTheDocAQuote() = runTest {
        val fake = FakeFunctionsClient()
        fake.stub("denyQuote", buildJsonObject {
            put("ok", true)
            put("invoiceId", "q1")
            put("status", "quote")
        })
        val res = PortalApi(fake).denyQuote(invoiceId = "q1", kinfolkId = "3")
        assertEquals(InvoiceStatus.Quote, res.status)
    }
}
