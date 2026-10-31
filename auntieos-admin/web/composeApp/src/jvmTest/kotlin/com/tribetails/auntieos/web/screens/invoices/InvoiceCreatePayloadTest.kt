package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.UninvoicedSession
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
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
 * #1178: what actually goes on the wire when the desktop composer creates an
 * invoice or a quote, and how the two un-invoiced callables are read. Drives the
 * real `FirestoreClient` through the jvm `platformInvokeCallable`, which records
 * the payload in `JvmFirestoreFixtures`.
 */
class InvoiceCreatePayloadTest {

    // Before as well as after: another class's last callable must not leak in.
    @BeforeTest
    fun setUp() = JvmFirestoreFixtures.clear()
    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private val sessions = listOf(
        UninvoicedSession("s1", "kf1", "Dog walk", 30.0, "2026-10-02T15:00:00.000Z", 2500L),
        UninvoicedSession("s2", "kf1", "Drop-in", 20.0, "2026-10-09T09:00:00.000Z", 1800L),
    )

    private fun composed(
        isQuote: Boolean = false,
        drafts: List<ComposerDraftLine> = listOf(ComposerDraftLine("Mileage", "10", "0.50", "1.00")),
        sendToKinfolk: Boolean = false,
    ): NewInvoiceRequest {
        val selected = setOf("s1", "s2")
        val due = resolveDueDate(InvoiceTermsCode.NET_14, "2026-10-20", sessions.map { it.startTime }, "2026-10-20")
        val money = composerMoney(sessions, selected, emptyMap(), drafts, "2.00")
        return assertNotNull(
            buildNewInvoiceRequest(
                isQuote, "kf1", "Ada Wren", InvoiceCreatePath.WORK, "2026-10-20",
                InvoiceTermsCode.NET_14, due, "", money, "", sendToKinfolk,
            ).request,
        )
    }

    private fun lastPayload(): JsonObject =
        Json.parseToJsonElement(assertNotNull(JvmFirestoreFixtures.lastCallablePayloadJson)).jsonObject

    @Test
    fun aComposedInvoiceGoesOutAsAnItemizedDraftWithNoNumber() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("createInvoice" to """{"ok":true,"invoiceId":"inv_1"}""")
        val r = composed()
        val result = FirestoreClient().createInvoice(
            r.invoice,
            idempotencyKey = "inv_1757000000000_a1b2c3",
            termsCode = r.termsCode,
            lineItems = r.lineItems,
            invoiceDiscountCents = r.invoiceDiscountCents,
        )
        assertTrue(result is WriteResult.Ok)
        assertEquals("createInvoice", JvmFirestoreFixtures.lastCallableName)

        val p = lastPayload()
        assertEquals("kf1", p["familyId"]!!.jsonPrimitive.content)
        assertEquals("draft", p["status"]!!.jsonPrimitive.content)
        assertEquals("net_14", p["termsCode"]!!.jsonPrimitive.content)
        assertEquals("2026-10-20", p["date"]!!.jsonPrimitive.content)
        assertEquals("2026-11-03", p["dueDate"]!!.jsonPrimitive.content)
        assertEquals("Ada Wren", p["client"]!!.jsonPrimitive.content)
        assertFalse("invoiceNumber" in p, "a blank invoice number is omitted so the server assigns one")
        assertEquals(200L, p["invoiceDiscountCents"]!!.jsonPrimitive.long)
        // 25.00 + 18.00 + (5.00 - 1.00) - 2.00
        assertEquals("45.0", p["total"]!!.jsonPrimitive.content)
        assertEquals("45.0", p["amountDue"]!!.jsonPrimitive.content)
        assertEquals(listOf("s1", "s2"), p["sessionIds"]!!.jsonArray.map { it.jsonPrimitive.content })

        val lines = p["lineItems"]!!.jsonArray.map { it.jsonObject }
        assertEquals(3, lines.size)
        assertEquals("Dog walk, 2026-10-02", lines[0]["description"]!!.jsonPrimitive.content)
        assertEquals(2500L, lines[0]["unitCents"]!!.jsonPrimitive.long)
        assertEquals("s1", lines[0]["sessionId"]!!.jsonPrimitive.content)
        assertFalse("discountCents" in lines[0], "a zero line discount is omitted")
        assertFalse("sessionId" in lines[2], "a typed line has no visit behind it")
        assertEquals(100L, lines[2]["discountCents"]!!.jsonPrimitive.long)
        assertEquals("inv_1757000000000_a1b2c3", p["idempotencyKey"]!!.jsonPrimitive.content)
    }

    @Test
    fun aComposedQuoteCarriesTheSendFlagAndNoStatus() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("createQuote" to """{"ok":true,"invoiceId":"quot_1"}""")
        val r = composed(isQuote = true, sendToKinfolk = true)
        FirestoreClient().createQuote(
            r.invoice,
            r.sendToKinfolk,
            termsCode = r.termsCode,
            lineItems = r.lineItems,
            invoiceDiscountCents = r.invoiceDiscountCents,
        )
        assertEquals("createQuote", JvmFirestoreFixtures.lastCallableName)
        val p = lastPayload()
        assertEquals("true", p["sendToKinfolk"]!!.jsonPrimitive.content)
        assertFalse("status" in p, "the server forces QUOTE; the client states nothing about it")
        assertEquals("net_14", p["termsCode"]!!.jsonPrimitive.content)
        assertEquals(3, p["lineItems"]!!.jsonArray.size)
    }

    @Test
    fun theBlankPathSendsNoLineItemsKeyAtAll() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("createInvoice" to """{"ok":true,"invoiceId":"inv_2"}""")
        val due = resolveDueDate(InvoiceTermsCode.DUE_ON_RECEIPT, "2026-10-20", emptyList(), "2026-10-20")
        val r = assertNotNull(
            buildNewInvoiceRequest(
                false, "kf1", "Ada Wren", InvoiceCreatePath.BLANK, "2026-10-20",
                InvoiceTermsCode.DUE_ON_RECEIPT, due, "", null, "40", false,
            ).request,
        )
        FirestoreClient().createInvoice(r.invoice, termsCode = r.termsCode, lineItems = r.lineItems, invoiceDiscountCents = r.invoiceDiscountCents)
        val p = lastPayload()
        assertFalse("lineItems" in p, "an empty array would arm the server's recompute on a typed total")
        assertFalse("invoiceDiscountCents" in p)
        assertEquals("40.0", p["total"]!!.jsonPrimitive.content)
        assertEquals("due_on_receipt", p["termsCode"]!!.jsonPrimitive.content)
        assertEquals("2026-10-20", p["dueDate"]!!.jsonPrimitive.content)
        assertEquals("draft", p["status"]!!.jsonPrimitive.content)
    }

    @Test
    fun listUninvoicedSessionsSendsTheHouseholdAndKeepsANullPriceNull() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listUninvoicedSessions" to """
                {"sessions":[
                  {"sessionId":"s1","kinfolkId":"kf1","serviceType":"Dog walk","durationMinutes":30,"startTime":"2026-10-02T15:00:00.000Z","unitCents":2500},
                  {"sessionId":"s3","kinfolkId":"kf1","serviceType":"Overnight","durationMinutes":600,"startTime":"2026-10-05T20:00:00.000Z","unitCents":null}
                 ],
                 "unpriceable":[{"sessionId":"s3","serviceType":"Overnight"}],
                 "unplaceable":[{"sessionId":"s9","kinfolkId":"kf1"}],
                 "excluded":[{"sessionId":"s4","kinfolkId":"kf1","serviceType":"Drop-in","startTime":"2026-09-30T10:00:00.000Z","reason":"comped"}],
                 "rateCardLoaded":true,"scanned":14,"truncated":false}
            """.trimIndent(),
        )
        val r = FirestoreClient().listUninvoicedSessions("kf1")
        assertEquals("listUninvoicedSessions", JvmFirestoreFixtures.lastCallableName)
        val p = lastPayload()
        assertEquals("kf1", p["kinfolkId"]!!.jsonPrimitive.content)
        assertFalse("from" in p)
        assertFalse("to" in p)

        val v = (r as WriteResult.Ok).value
        assertEquals(listOf("s1", "s3"), v.sessions.map { it.sessionId })
        assertEquals(2500L, v.sessions[0].unitCents)
        assertNull(v.sessions[1].unitCents, "an unpriced visit is never read as zero")
        assertEquals(listOf("s3"), v.unpriceable.map { it.sessionId })
        assertEquals(listOf("s9"), v.unplaceable.map { it.sessionId })
        assertEquals("comped", v.excluded.single().reason)
        assertTrue(v.rateCardLoaded)
        assertEquals(14L, v.scanned)
    }

    @Test
    fun listUninvoicedSessionsRefusesHalfARangeBeforeTheRoundTrip() = runBlocking {
        val r = FirestoreClient().listUninvoicedSessions("kf1", "2026-09-01", null)
        assertTrue(r is WriteResult.Err)
        assertNull(JvmFirestoreFixtures.lastCallableName)
    }

    @Test
    fun aListFailureIsAnErrNotAnEmptyList() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("listUninvoicedSessions" to "permission denied")
        val r = FirestoreClient().listUninvoicedSessions("kf1")
        assertEquals("permission denied", (r as WriteResult.Err).message)
    }

    @Test
    fun setSessionDoNotInvoiceSendsIdsFlagAndReason() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "setSessionDoNotInvoice" to """{"ok":true,"doNotInvoice":true,"changed":["s1"],"unchanged":["s2"]}""",
        )
        val r = FirestoreClient().setSessionDoNotInvoice(listOf("s1", "s2"), true, "comped")
        assertEquals("setSessionDoNotInvoice", JvmFirestoreFixtures.lastCallableName)
        val p = lastPayload()
        assertEquals(listOf("s1", "s2"), (p["sessionIds"] as JsonArray).map { it.jsonPrimitive.content })
        assertEquals("true", p["doNotInvoice"]!!.jsonPrimitive.content)
        assertEquals("comped", p["reason"]!!.jsonPrimitive.content)
        val v = (r as WriteResult.Ok).value
        assertEquals(listOf("s1"), v.changed)
        assertEquals(listOf("s2"), v.unchanged)
    }
}
