package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.UnappliedDecision
import com.tribetails.auntieos.web.data.UnappliedDecisionOutcome
import com.tribetails.auntieos.web.data.UnappliedDecisionSubmissionKeys
import com.tribetails.auntieos.web.data.UnappliedPaymentsLoad
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.loadUnappliedPayments
import com.tribetails.auntieos.web.data.submitUnappliedDecision
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotEquals

/**
 * #1003: the desktop list and Decide dialog go through `listUnappliedPayments`
 * and `resolveUnappliedPayment`. The jvm `platformInvokeCallable` records every
 * (name, payload) and answers from the fixtures.
 */
class ResolveUnappliedCallableClientTest {

    @BeforeTest
    fun setUp() = JvmFirestoreFixtures.clear()

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private val decision = UnappliedDecision("evt_1", creditCents = 1000, creditReason = "Missed visit", applyInvoiceId = "inv50", applyCents = 1500)

    private val okBody = """
        {"ok":true,"paymentId":"evt_1","kinfolkId":"kf1","paymentCents":2500,"creditedCents":1000,"creditId":"upd_1_k1",
         "appliedCents":1500,"appliedInvoiceId":"inv50","appliedInvoiceNumber":"INV-1050","appliedInvoiceState":"settled",
         "appliedInvoiceAmountDueCents":0,"keptCents":0,"newAccountBalanceCents":3700,"replayed":false,"extra":1}
    """.trimIndent()

    private fun sent(): List<JsonObject> = JvmFirestoreFixtures.callablePayloads
        .filter { it.first == "resolveUnappliedPayment" }
        .map { Json.parseToJsonElement(it.second).jsonObject }

    @Test
    fun sendsTheDecisionInCentsWithAKey(): Unit = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("resolveUnappliedPayment" to okBody)
        val r = submitUnappliedDecision(FirestoreClient(), decision, UnappliedDecisionSubmissionKeys { "upd_1_k1" })
        val p = sent().single()
        assertEquals(
            setOf("paymentId", "creditCents", "creditReason", "applyInvoiceId", "applyCents", "idempotencyKey"),
            p.keys,
        )
        assertEquals("evt_1", p["paymentId"]!!.jsonPrimitive.content)
        assertEquals(1000L, p["creditCents"]!!.jsonPrimitive.long)
        assertEquals("Missed visit", p["creditReason"]!!.jsonPrimitive.content)
        assertEquals("inv50", p["applyInvoiceId"]!!.jsonPrimitive.content)
        assertEquals(1500L, p["applyCents"]!!.jsonPrimitive.long)
        assertEquals("upd_1_k1", p["idempotencyKey"]!!.jsonPrimitive.content)
        val outcome = assertIs<WriteResult.Ok<*>>(r).value as UnappliedDecisionOutcome
        assertEquals(
            "Decision saved. \$10.00 to account credit (balance now \$37.00). " +
                "\$15.00 on invoice INV-1050 (paid in full). \$0.00 kept on the payment.",
            decisionResultText(outcome),
        )
    }

    @Test
    fun aFailedAttemptKeepsTheKeySoTheRetryIsTheSameDecision(): Unit = runBlocking {
        var n = 0
        val keys = UnappliedDecisionSubmissionKeys { "upd_1_k${++n}" }
        JvmFirestoreFixtures.callableErrors = mapOf("resolveUnappliedPayment" to "deadline-exceeded")
        val first = submitUnappliedDecision(FirestoreClient(), decision, keys)
        assertIs<WriteResult.Err>(first)
        JvmFirestoreFixtures.callableErrors = emptyMap()
        JvmFirestoreFixtures.callableResponses = mapOf("resolveUnappliedPayment" to okBody)
        submitUnappliedDecision(FirestoreClient(), decision, keys)
        assertEquals(listOf("upd_1_k1", "upd_1_k1"), sent().map { it["idempotencyKey"]!!.jsonPrimitive.content })
    }

    @Test
    fun aChangedDecisionGetsANewKey(): Unit = runBlocking {
        var n = 0
        val keys = UnappliedDecisionSubmissionKeys { "upd_1_k${++n}" }
        JvmFirestoreFixtures.callableErrors = mapOf("resolveUnappliedPayment" to "internal")
        submitUnappliedDecision(FirestoreClient(), decision, keys)
        submitUnappliedDecision(FirestoreClient(), decision.copy(applyCents = 1400), keys)
        assertEquals(listOf("upd_1_k1", "upd_1_k2"), sent().map { it["idempotencyKey"]!!.jsonPrimitive.content })
    }

    @Test
    fun aSuccessReleasesTheKey(): Unit = runBlocking {
        var n = 0
        val keys = UnappliedDecisionSubmissionKeys { "upd_1_k${++n}" }
        JvmFirestoreFixtures.callableResponses = mapOf("resolveUnappliedPayment" to okBody)
        submitUnappliedDecision(FirestoreClient(), decision, keys)
        submitUnappliedDecision(FirestoreClient(), decision, keys)
        val sentKeys = sent().map { it["idempotencyKey"]!!.jsonPrimitive.content }
        assertNotEquals(sentKeys[0], sentKeys[1])
    }

    @Test
    fun theServerMessageComesBackAsIs(): Unit = runBlocking {
        val msg = "This payment was already decided."
        JvmFirestoreFixtures.callableErrors = mapOf("resolveUnappliedPayment" to msg)
        val r = submitUnappliedDecision(FirestoreClient(), decision, UnappliedDecisionSubmissionKeys { "upd_1_k1" })
        assertEquals(msg, assertIs<WriteResult.Err>(r).message)
    }

    @Test
    fun theListIsReadForThisHousehold(): Unit = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "listUnappliedPayments" to """{"ok":true,"kinfolkId":"kf1","payments":[],"openInvoices":[]}""",
        )
        val load = loadUnappliedPayments(FirestoreClient(), "kf1")
        val payload = Json.parseToJsonElement(JvmFirestoreFixtures.callablePayloads.single().second).jsonObject
        assertEquals(setOf("kinfolkId"), payload.keys)
        assertEquals("kf1", payload["kinfolkId"]!!.jsonPrimitive.content)
        assertEquals(0, assertIs<UnappliedPaymentsLoad.Loaded>(load).list.payments.size)
    }

    @Test
    fun aRefusedListHidesAndAnyOtherFailureShows(): Unit = runBlocking {
        for (msg in listOf("PERMISSION_DENIED", "This household is outside your test sandbox.")) {
            JvmFirestoreFixtures.callableErrors = mapOf("listUnappliedPayments" to msg)
            assertEquals(UnappliedPaymentsLoad.Hidden, loadUnappliedPayments(FirestoreClient(), "kf1"), msg)
        }
        JvmFirestoreFixtures.callableErrors = mapOf("listUnappliedPayments" to "deadline-exceeded")
        assertEquals(UnappliedPaymentsLoad.Failed("deadline-exceeded"), loadUnappliedPayments(FirestoreClient(), "kf1"))
    }
}
