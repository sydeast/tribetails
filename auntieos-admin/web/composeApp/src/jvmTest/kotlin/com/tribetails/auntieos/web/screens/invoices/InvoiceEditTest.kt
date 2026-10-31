package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.JvmFirestoreRest
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1174 on the desktop console: the invoice editor's gating, the payload it
 * sends to `updateInvoice`, and the decode of the stored fields it reads.
 *
 * PAYLOAD ASSERTIONS ARE ON THE JSON THAT LEFT FOR THE CALLABLE. The server's
 * patch schema is `.strict()` and a key that is present at all is a write, so
 * "this field was not sent" is checked as key absence on the wire.
 */
class InvoiceEditTest {

    @BeforeTest fun setUp() = JvmFirestoreFixtures.clear()
    @AfterTest fun tearDown() = JvmFirestoreFixtures.clear()

    /** Decoded through the desktop REST codec, the way the invoice list reads it. */
    private fun invoiceFromJson(json: String): Invoice = JvmFirestoreRest.codec.decodeFromString(Invoice.serializer(), json)

    private fun itemized(scope: String = "all") = invoiceFromJson(
        """
        {"_id":"inv1","kinfolkId":"fam1","kinfolkName":"Wanda Thorne","invoiceNumber":"1042",
         "client":"Wanda Thorne","address":"12 Elm Row","date":"2026-10-01","dueDate":"2026-10-15",
         "terms":"Net 14","discount":"10%","total":60.0,"amountDue":60.0,"status":"open","editScope":"$scope",
         "lineItems":[
           {"description":"Dog walk","qty":2,"unitCents":2500,"sessionId":"s1"},
           {"description":"Mileage","qty":1,"unitCents":1000}
         ],
         "invoiceDiscountCents":0}
        """.trimIndent(),
    )

    private fun unitemized(scope: String = "all") = invoiceFromJson(
        """{"_id":"inv2","invoiceNumber":"1043","date":"2026-10-01","dueDate":"2026-10-15","total":40.0,"amountDue":40.0,"status":"open","editScope":"$scope"}""",
    )

    private fun patchOf(invoice: Invoice, draft: InvoiceEditDraft): JsonObject {
        val outcome = invoiceEditPatchOf(invoice, draft)
        assertNull(outcome.error, "unexpected refusal")
        return outcome.patch!!
    }

    // ── Decode ─────────────────────────────────────────────────────────────────

    @Test
    fun theStoredLinesAndScopeDecode() {
        val inv = itemized()
        assertEquals(InvoiceEditScope.ALL, invoiceEditScopeOf(inv))
        assertEquals(
            listOf(
                InvoiceEditLineItem("Dog walk", 2.0, 2500L, 0L, "s1"),
                InvoiceEditLineItem("Mileage", 1.0, 1000L, 0L, ""),
            ),
            invoiceEditLinesOf(inv),
        )
    }

    @Test
    fun absentLinesReadAsNeverItemizedNotEmpty() {
        assertNull(invoiceEditLinesOf(unitemized()))
    }

    @Test
    fun junkInTheLinesFieldDoesNotDropTheInvoice() {
        val inv = invoiceFromJson("""{"_id":"inv3","lineItems":"oops","invoiceDiscountCents":null,"editScope":null}""")
        assertEquals("inv3", inv._id)
        assertNull(invoiceEditLinesOf(inv))
        assertEquals(0L, invoiceDiscountCentsOf(inv))
        assertEquals(InvoiceEditScope.NONE, invoiceEditScopeOf(inv))
    }

    // ── Gating ─────────────────────────────────────────────────────────────────

    @Test
    fun scopeNoneOrAbsentOpensNoEditor() {
        assertNull(invoiceEditDraftOf(itemized(scope = "none")))
        assertNull(invoiceEditDraftOf(invoiceFromJson("""{"_id":"x","invoiceNumber":"1"}""")))
    }

    @Test
    fun scopeAllOpensTheMoney() {
        val draft = invoiceEditDraftOf(itemized())!!
        assertTrue(draft.moneyEditable)
        assertTrue(draft.wasItemized)
        assertEquals(InvoiceEditLine("Dog walk", "2", "25.00", "", "s1"), draft.lines[0])
    }

    @Test
    fun scopeMetadataOnlyShowsTheMoneyReadOnly() {
        val draft = invoiceEditDraftOf(itemized(scope = "metadataOnly"))!!
        assertFalse(draft.moneyEditable)
        assertEquals(listOf("Dog walk", "Mileage"), draft.lines.map { it.description })
    }

    // ── Payload ────────────────────────────────────────────────────────────────

    @Test
    fun onlyChangedMetadataIsSent() {
        val inv = itemized(scope = "metadataOnly")
        val patch = patchOf(inv, invoiceEditDraftOf(inv)!!.copy(dueDate = "2026-10-30"))
        assertEquals(setOf("dueDate"), patch.keys)
        assertEquals("2026-10-30", patch["dueDate"]!!.jsonPrimitive.content)
    }

    @Test
    fun metadataOnlyNeverSendsMoney() {
        val inv = itemized(scope = "metadataOnly")
        val base = invoiceEditDraftOf(inv)!!
        val draft = base.copy(
            terms = "Net 30",
            lines = base.lines.replacedAt(1, base.lines[1].copy(unitText = "99.00")),
            invoiceDiscountText = "5",
        )
        assertEquals(setOf("terms"), patchOf(inv, draft).keys)
    }

    @Test
    fun aDueDateFixOnAnUnitemizedInvoiceSendsNoLineItems() {
        val inv = unitemized()
        val patch = patchOf(inv, invoiceEditDraftOf(inv)!!.copy(dueDate = "2026-11-01"))
        assertEquals(setOf("dueDate"), patch.keys)
    }

    @Test
    fun aMoneyEditSendsLinesAndDiscountTogetherAndKeepsTheBinding() {
        val inv = itemized()
        val base = invoiceEditDraftOf(inv)!!
        val draft = base.copy(
            lines = base.lines.replacedAt(1, base.lines[1].copy(qtyText = "3", discountText = "2.50")),
            invoiceDiscountText = "5",
        )
        val patch = patchOf(inv, draft)
        assertEquals(setOf("lineItems", "invoiceDiscountCents"), patch.keys)
        val lines = patch["lineItems"]!!.jsonArray.map { it.jsonObject }
        assertEquals("s1", lines[0]["sessionId"]!!.jsonPrimitive.content)
        assertFalse(lines[0].containsKey("discountCents"))
        assertEquals(1000L, lines[1]["unitCents"]!!.jsonPrimitive.long)
        assertEquals(250L, lines[1]["discountCents"]!!.jsonPrimitive.long)
        assertFalse(lines[1].containsKey("sessionId"))
        assertEquals(500L, patch["invoiceDiscountCents"]!!.jsonPrimitive.long)
    }

    @Test
    fun nothingChangedIsRefusedBeforeTheCall() {
        val inv = itemized(scope = "metadataOnly")
        val outcome = invoiceEditPatchOf(inv, invoiceEditDraftOf(inv)!!)
        assertNull(outcome.patch)
        assertEquals("Nothing has changed yet.", outcome.error)
    }

    @Test
    fun badInputIsRefusedWithTheWebEditorsSentences() {
        val inv = itemized()
        val base = invoiceEditDraftOf(inv)!!
        assertEquals(
            "Unit price for \"Mileage\" needs a dollar amount, for example 25.00.",
            invoiceEditPatchOf(inv, base.copy(lines = base.lines.replacedAt(1, base.lines[1].copy(unitText = "ten")))).error,
        )
        assertEquals(
            "Invoice discount (\$100.00) is larger than the subtotal (\$60.00).",
            invoiceEditPatchOf(inv, base.copy(invoiceDiscountText = "100")).error,
        )
        assertEquals("The due date needs to be a date like 2026-10-23.", invoiceEditPatchOf(inv, base.copy(dueDate = "soon")).error)
        assertEquals("The invoice number cannot be empty.", invoiceEditPatchOf(inv, base.copy(invoiceNumber = " ")).error)
    }

    // ── The callable ───────────────────────────────────────────────────────────

    @Test
    fun updateInvoiceSendsTheIdAndThePatchOnly() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "updateInvoice" to """{"ok":true,"invoiceId":"inv1","totals":{"subtotalCents":0,"totalCents":0,"paidCents":0,"amountDueCents":0}}""",
        )
        val inv = itemized(scope = "metadataOnly")
        val patch = patchOf(inv, invoiceEditDraftOf(inv)!!.copy(terms = "Net 30"))
        val r = FirestoreClient().updateInvoice(inv._id, patch)
        assertTrue(r is WriteResult.Ok, "$r")
        val (name, body) = JvmFirestoreFixtures.callablePayloads.single()
        assertEquals("updateInvoice", name)
        val sent = Json.parseToJsonElement(body).jsonObject
        assertEquals(setOf("invoiceId", "patch"), sent.keys)
        assertEquals("inv1", sent["invoiceId"]!!.jsonPrimitive.content)
        // No client, address, kinfolkName, total or status: nothing the form does not control.
        assertEquals(mapOf("terms" to "Net 30"), sent["patch"]!!.jsonObject.mapValues { it.value.jsonPrimitive.content })
        assertNull(JvmFirestoreFixtures.lastWrite, "no direct REST write may happen")
    }

    @Test
    fun aRefusalComesBackVerbatim() = runBlocking {
        val refusal = "This invoice has a recorded payment, so its money is locked."
        JvmFirestoreFixtures.callableErrors = mapOf("updateInvoice" to refusal)
        val r = FirestoreClient().updateInvoice("inv1", JsonObject(mapOf()))
        assertTrue(r is WriteResult.Err)
        assertEquals(refusal, (r as WriteResult.Err).message)
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    @Test
    fun moneyTextRoundTrips() {
        assertEquals(125000L, parseDollarsToCents("$1,250.00"))
        assertNull(parseDollarsToCents("12.345"))
        assertEquals("12.05", centsToInputDollars(1205))
        assertEquals("-\$3.50", formatEditCents(-350))
        assertEquals("2.5", formatEditQty(2.5))
        assertEquals("3", formatEditQty(3.0))
        assertNotNull(parseQty("0.5"))
        assertNull(parseQty("0"))
    }

    @Test
    fun thePreviewCountsUnreadableRows() {
        val preview = invoiceEditPreviewOf(listOf(InvoiceEditLine("A", "2", "10"), InvoiceEditLine("B", "1", "")), "5")
        assertEquals(1500L, preview.totalCents)
        assertEquals(1, preview.unreadable)
    }
}
