package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.CreditHistoryLoad
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.GiveCreditEntry
import com.tribetails.auntieos.web.data.GiveCreditSubmissionKeys
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.loadAccountCreditHistory
import com.tribetails.auntieos.web.data.submitGiveCredit
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
import kotlin.test.assertTrue

/**
 * Q6: the desktop Give credit dialog and the credit history go through the
 * `giveAccountCredit` and `getAccountCreditHistory` callables. The jvm
 * `platformInvokeCallable` records every (name, payload) and answers from the
 * fixtures, so these read the exact JSON the console would send.
 */
class GiveCreditCallableClientTest {

    @BeforeTest
    fun setUp() = JvmFirestoreFixtures.clear()

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private val entry = GiveCreditEntry(kinfolkId = "kf1", amountCents = 2500, reason = "Missed visit")

    private val okBody =
        """{"ok":true,"creditId":"crd_1790000000000_abc123","amountCents":2500,"newAccountBalanceCents":3700,"replayed":false,"extra":1}"""

    private fun sent(): List<JsonObject> = JvmFirestoreFixtures.callablePayloads
        .filter { it.first == "giveAccountCredit" }
        .map { Json.parseToJsonElement(it.second).jsonObject }

    @Test
    fun sendsTheAmountInCentsTheReasonAndAKey(): Unit = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("giveAccountCredit" to okBody)
        val r = submitGiveCredit(FirestoreClient(), entry, GiveCreditSubmissionKeys { "crd_1_k1" })
        val p = sent().single()
        assertEquals(setOf("kinfolkId", "amountCents", "reason", "idempotencyKey"), p.keys)
        assertEquals("kf1", p["kinfolkId"]!!.jsonPrimitive.content)
        assertEquals(2500L, p["amountCents"]!!.jsonPrimitive.long)
        assertEquals("Missed visit", p["reason"]!!.jsonPrimitive.content)
        assertEquals("crd_1_k1", p["idempotencyKey"]!!.jsonPrimitive.content)
        val ok = assertIs<WriteResult.Ok<*>>(r)
        val outcome = ok.value as com.tribetails.auntieos.web.data.GiveCreditOutcome
        assertEquals(3700L, outcome.newAccountBalanceCents)
        assertEquals("Credit given. Balance is now \$37.00.", giveCreditSuccessText(outcome.newAccountBalanceCents))
    }

    @Test
    fun aFailedAttemptKeepsTheKeySoTheRetryIsTheSameCredit(): Unit = runBlocking {
        var n = 0
        val keys = GiveCreditSubmissionKeys { "crd_1_k${++n}" }
        JvmFirestoreFixtures.callableErrors = mapOf("giveAccountCredit" to "deadline-exceeded")
        val first = submitGiveCredit(FirestoreClient(), entry, keys)
        assertIs<WriteResult.Err>(first)
        JvmFirestoreFixtures.callableErrors = emptyMap()
        JvmFirestoreFixtures.callableResponses = mapOf("giveAccountCredit" to okBody)
        submitGiveCredit(FirestoreClient(), entry, keys)
        val keysSent = sent().map { it["idempotencyKey"]!!.jsonPrimitive.content }
        assertEquals(listOf("crd_1_k1", "crd_1_k1"), keysSent)
    }

    @Test
    fun aSuccessReleasesTheKeySoTheNextCreditIsNew(): Unit = runBlocking {
        var n = 0
        val keys = GiveCreditSubmissionKeys { "crd_1_k${++n}" }
        JvmFirestoreFixtures.callableResponses = mapOf("giveAccountCredit" to okBody)
        submitGiveCredit(FirestoreClient(), entry, keys)
        submitGiveCredit(FirestoreClient(), entry, keys)
        val keysSent = sent().map { it["idempotencyKey"]!!.jsonPrimitive.content }
        assertNotEquals(keysSent[0], keysSent[1])
    }

    @Test
    fun aChangedCreditGetsANewKey(): Unit = runBlocking {
        var n = 0
        val keys = GiveCreditSubmissionKeys { "crd_1_k${++n}" }
        JvmFirestoreFixtures.callableErrors = mapOf("giveAccountCredit" to "internal")
        submitGiveCredit(FirestoreClient(), entry, keys)
        submitGiveCredit(FirestoreClient(), entry.copy(amountCents = 3000), keys)
        val keysSent = sent().map { it["idempotencyKey"]!!.jsonPrimitive.content }
        assertEquals(listOf("crd_1_k1", "crd_1_k2"), keysSent)
    }

    @Test
    fun theServerRefusalComesBackAsAnError(): Unit = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("giveAccountCredit" to "Household not found.")
        val r = submitGiveCredit(FirestoreClient(), entry, GiveCreditSubmissionKeys { "crd_1_k1" })
        val err = assertIs<WriteResult.Err>(r)
        assertEquals("Couldn't give credit: Household not found.", giveCreditRefusalText(err.message))
    }

    @Test
    fun anAnswerWithNoBalanceIsNotAGivenCredit(): Unit = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("giveAccountCredit" to """{"ok":true,"creditId":"c1"}""")
        val r = submitGiveCredit(FirestoreClient(), entry, GiveCreditSubmissionKeys { "crd_1_k1" })
        assertIs<WriteResult.Err>(r)
    }

    @Test
    fun theHistoryIsReadForThisHouseholdAndDecoded(): Unit = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "getAccountCreditHistory" to """
                {"ok":true,"kinfolkId":"kf1","accountBalanceCents":1000,"future":true,
                 "credits":[{"creditId":"c1","amountCents":2500,"reason":"Missed visit","givenAtMs":1000,
                   "remainingCents":0,"fullyAppliedAtMs":2000,
                   "applications":[{"appliedAtMs":2000,"amountCents":2500,"invoiceId":"inv9","invoiceNumber":"INV-1009"}]}],
                 "uses":[{"useId":"d1","usedAtMs":2000,"amountCents":2500,"invoiceId":"inv9","invoiceNumber":null}]}
            """.trimIndent(),
        )
        val load = loadAccountCreditHistory(FirestoreClient(), "kf1")
        val payload = Json.parseToJsonElement(JvmFirestoreFixtures.callablePayloads.single().second).jsonObject
        assertEquals("kf1", payload["kinfolkId"]!!.jsonPrimitive.content)
        val h = assertIs<CreditHistoryLoad.Loaded>(load).history
        assertEquals(1000L, h.accountBalanceCents)
        assertEquals(2000L, h.credits.single().fullyAppliedAtMs)
        assertEquals("INV-1009", h.credits.single().applications.single().invoiceNumber)
        assertEquals(null, h.uses.single().invoiceNumber)
    }

    @Test
    fun aRefusedHistoryHidesThePanel(): Unit = runBlocking {
        for (msg in listOf(
            "Billing access is required to see account credit.",
            "This is not available to caretaker accounts.",
            "PERMISSION_DENIED",
        )) {
            JvmFirestoreFixtures.callableErrors = mapOf("getAccountCreditHistory" to msg)
            assertEquals(CreditHistoryLoad.Hidden, loadAccountCreditHistory(FirestoreClient(), "kf1"), msg)
        }
    }

    @Test
    fun anyOtherHistoryFailureIsShown(): Unit = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("getAccountCreditHistory" to "deadline-exceeded")
        val load = loadAccountCreditHistory(FirestoreClient(), "kf1")
        assertTrue(load is CreditHistoryLoad.Failed && load.message == "deadline-exceeded")
    }
}
