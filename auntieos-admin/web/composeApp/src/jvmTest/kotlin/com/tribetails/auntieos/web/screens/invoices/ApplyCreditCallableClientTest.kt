package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.ApplyCreditEntry
import com.tribetails.auntieos.web.data.ApplyCreditOutcome
import com.tribetails.auntieos.web.data.ApplyCreditSubmissionKeys
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.submitApplyCredit
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
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1872 (operator ruling 2026-11-11): the desktop console applies account
 * credit to an invoice through the `applyAccountCredit` callable, by an amount
 * the admin types. The jvm `platformInvokeCallable` records every (name,
 * payload) and answers from the fixtures, so these read the exact JSON the
 * console would send, and drive the block's controller end to end.
 */
class ApplyCreditCallableClientTest {

    @BeforeTest
    fun setUp() = JvmFirestoreFixtures.clear()

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private val entry = ApplyCreditEntry(invoiceId = "inv1", amountCents = 2500)

    private val okBody =
        """{"ok":true,"invoiceId":"inv1","paymentId":"acr_1_k1","appliedCents":2500,"amountDueCents":7500,"accountBalanceCents":9500,"replayed":false,"extra":1}"""

    private fun historyBody(balance: Long) =
        """{"ok":true,"kinfolkId":"kf1","accountBalanceCents":$balance,"credits":[],"uses":[]}"""

    private fun sent(name: String = "applyAccountCredit"): List<JsonObject> = JvmFirestoreFixtures.callablePayloads
        .filter { it.first == name }
        .map { Json.parseToJsonElement(it.second).jsonObject }

    // ── the wire ────────────────────────────────────────────────────────────

    @Test
    fun sendsTheInvoiceTheAmountInCentsAndAKey(): Unit = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("applyAccountCredit" to okBody)
        val r = submitApplyCredit(FirestoreClient(), entry, ApplyCreditSubmissionKeys { "acr_1_k1" })
        val p = sent().single()
        assertEquals(setOf("invoiceId", "amountCents", "idempotencyKey"), p.keys)
        assertEquals("inv1", p["invoiceId"]!!.jsonPrimitive.content)
        assertEquals(2500L, p["amountCents"]!!.jsonPrimitive.long)
        assertEquals("acr_1_k1", p["idempotencyKey"]!!.jsonPrimitive.content)
        val ok = assertIs<WriteResult.Ok<*>>(r)
        assertEquals(ApplyCreditOutcome("inv1", "acr_1_k1", 2500L, 7500L, 9500L, false), ok.value)
    }

    @Test
    fun aFailedAttemptKeepsTheKeySoTheRetryIsTheSamePayment(): Unit = runBlocking {
        var n = 0
        val keys = ApplyCreditSubmissionKeys { "acr_1_k${++n}" }
        JvmFirestoreFixtures.callableErrors = mapOf("applyAccountCredit" to "deadline-exceeded")
        assertIs<WriteResult.Err>(submitApplyCredit(FirestoreClient(), entry, keys))
        JvmFirestoreFixtures.callableErrors = emptyMap()
        JvmFirestoreFixtures.callableResponses = mapOf("applyAccountCredit" to okBody)
        submitApplyCredit(FirestoreClient(), entry, keys)
        assertEquals(listOf("acr_1_k1", "acr_1_k1"), sent().map { it["idempotencyKey"]!!.jsonPrimitive.content })
    }

    @Test
    fun aChangedAmountGetsANewKeyAndASuccessReleasesIt(): Unit = runBlocking {
        var n = 0
        val keys = ApplyCreditSubmissionKeys { "acr_1_k${++n}" }
        JvmFirestoreFixtures.callableErrors = mapOf("applyAccountCredit" to "internal")
        submitApplyCredit(FirestoreClient(), entry, keys)
        submitApplyCredit(FirestoreClient(), entry.copy(amountCents = 1100), keys)
        JvmFirestoreFixtures.callableErrors = emptyMap()
        JvmFirestoreFixtures.callableResponses = mapOf("applyAccountCredit" to okBody)
        submitApplyCredit(FirestoreClient(), entry.copy(amountCents = 1100), keys)
        // The same amount applied again on purpose is a new payment.
        submitApplyCredit(FirestoreClient(), entry.copy(amountCents = 1100), keys)
        assertEquals(
            listOf("acr_1_k1", "acr_1_k2", "acr_1_k2", "acr_1_k3"),
            sent().map { it["idempotencyKey"]!!.jsonPrimitive.content },
        )
    }

    @Test
    fun theServerRefusalComesBackInItsOwnWords(): Unit = runBlocking {
        JvmFirestoreFixtures.callableErrors =
            mapOf("applyAccountCredit" to "This invoice is already paid, so it takes no credit.")
        val r = submitApplyCredit(FirestoreClient(), entry, ApplyCreditSubmissionKeys { "acr_1_k1" })
        assertEquals("This invoice is already paid, so it takes no credit.", assertIs<WriteResult.Err>(r).message)
    }

    @Test
    fun anAnswerWithNoFiguresIsNotAnAppliedCredit(): Unit = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("applyAccountCredit" to """{"ok":true,"paymentId":"p1"}""")
        assertIs<WriteResult.Err>(submitApplyCredit(FirestoreClient(), entry, ApplyCreditSubmissionKeys { "acr_1_k1" }))
    }

    // ── the block's controller ──────────────────────────────────────────────

    private suspend fun loaded(balance: Long = 12000L): ApplyCreditController {
        JvmFirestoreFixtures.callableResponses = mapOf("getAccountCreditHistory" to historyBody(balance))
        var n = 0
        val c = ApplyCreditController(FirestoreClient(), "inv1", "kf1", ApplyCreditSubmissionKeys { "acr_1_k${++n}" })
        c.load()
        return c
    }

    @Test
    fun loadsTheHouseholdsAvailableCredit(): Unit = runBlocking {
        val c = loaded()
        assertEquals(ApplyCreditBalance.Ready(12000L), c.state.value.balance)
        assertEquals("kf1", sent("getAccountCreditHistory").single()["kinfolkId"]!!.jsonPrimitive.content)
    }

    @Test
    fun aRefusedBalanceReadHidesTheBlockBecauseAnAuntieNeverSeesMoney(): Unit = runBlocking {
        JvmFirestoreFixtures.callableErrors =
            mapOf("getAccountCreditHistory" to "This is not available to caretaker accounts.")
        val c = ApplyCreditController(FirestoreClient(), "inv1", "kf1")
        c.load()
        assertEquals(ApplyCreditBalance.Hidden, c.state.value.balance)
    }

    @Test
    fun anyOtherReadFailureIsShown(): Unit = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("getAccountCreditHistory" to "deadline-exceeded")
        val c = ApplyCreditController(FirestoreClient(), "inv1", "kf1")
        c.load()
        assertEquals(ApplyCreditBalance.Failed("deadline-exceeded"), c.state.value.balance)
    }

    @Test
    fun everyRefusalSitsOnTheFieldAndNothingIsSent(): Unit = runBlocking {
        val c = loaded()
        val cases = listOf(
            "" to "Enter an amount in dollars, like 25.00.",
            "abc" to "Enter an amount in dollars, like 25.00.",
            "-5" to "Enter an amount in dollars, like 25.00.",
            "0" to "Enter an amount above \$0.00.",
            "120.01" to "This household has \$120.00 of account credit. Enter that much or less.",
            "100.01" to "This invoice has \$100.00 left to pay. Enter that much or less.",
        )
        for ((typed, words) in cases) {
            c.setAmount(typed)
            c.review(10000L)
            assertEquals(words, c.state.value.fieldError, typed)
            assertEquals(ApplyCreditStep.Form, c.state.value.step, typed)
            // Confirm does nothing while the form has not passed.
            assertNull(c.confirm(), typed)
        }
        assertTrue(sent().isEmpty())
        // Typing again clears the refusal.
        c.setAmount("1")
        assertNull(c.state.value.fieldError)
    }

    @Test
    fun asksFirstAndSendsNothingUntilSheAgrees(): Unit = runBlocking {
        val c = loaded()
        c.setAmount("25")
        c.review(10000L)
        assertEquals(ApplyCreditStep.Confirm, c.state.value.step)
        assertEquals(2500L, c.state.value.pendingAmountCents)
        c.back()
        assertEquals(ApplyCreditStep.Form, c.state.value.step)
        assertEquals("25", c.state.value.amountText)
        assertTrue(sent().isEmpty())
    }

    @Test
    fun appliesTheAmountThenShowsTheServersBalanceAndClearsTheField(): Unit = runBlocking {
        val c = loaded()
        JvmFirestoreFixtures.callableResponses = mapOf(
            "applyAccountCredit" to okBody,
            "getAccountCreditHistory" to historyBody(9500L),
        )
        c.setAmount("25.00")
        c.review(10000L)
        val outcome = c.confirm()

        assertEquals(2500L, sent().single()["amountCents"]!!.jsonPrimitive.long)
        assertEquals("inv1", sent().single()["invoiceId"]!!.jsonPrimitive.content)
        assertEquals(
            "Applied \$25.00 of account credit to invoice 1026. \$75.00 is left to pay. " +
                "The household has \$95.00 of credit left.",
            applyCreditDoneText(outcome!!, "1026"),
        )
        val s = c.state.value
        assertFalse(s.busy)
        assertEquals(ApplyCreditStep.Form, s.step)
        assertEquals("", s.amountText)
        assertEquals(ApplyCreditBalance.Ready(9500L), s.balance)
        // The balance was read on open and again after the credit moved.
        assertEquals(2, sent("getAccountCreditHistory").size)
    }

    @Test
    fun aServerRefusalIsShownUnderTheFieldAndTheFormComesBack(): Unit = runBlocking {
        val c = loaded()
        JvmFirestoreFixtures.callableErrors =
            mapOf("applyAccountCredit" to "This invoice is already paid, so it takes no credit.")
        c.setAmount("25")
        c.review(10000L)
        assertNull(c.confirm())

        val s = c.state.value
        assertEquals("This invoice is already paid, so it takes no credit.", s.fieldError)
        assertEquals(ApplyCreditStep.Form, s.step)
        assertEquals("25", s.amountText)
        assertFalse(s.busy)
        // The balance is read again: what she holds or owes may have moved.
        assertEquals(2, sent("getAccountCreditHistory").size)
        assertEquals(ApplyCreditBalance.Ready(12000L), s.balance)
    }

    @Test
    fun pressingAgainAfterALostReplySendsTheSameKeyAndAChangedAmountANewOne(): Unit = runBlocking {
        val c = loaded()
        JvmFirestoreFixtures.callableErrors = mapOf("applyAccountCredit" to "internal")
        c.setAmount("25")
        c.review(10000L)
        c.confirm()
        c.review(10000L)
        c.confirm()
        c.setAmount("11")
        c.review(10000L)
        c.confirm()
        assertEquals(
            listOf("acr_1_k1", "acr_1_k1", "acr_1_k2"),
            sent().map { it["idempotencyKey"]!!.jsonPrimitive.content },
        )
        assertEquals(listOf(2500L, 2500L, 1100L), sent().map { it["amountCents"]!!.jsonPrimitive.long })
    }

    @Test
    fun aPressWhileOneIsInFlightDoesNothing(): Unit = runBlocking {
        val c = loaded()
        JvmFirestoreFixtures.callableResponses = mapOf(
            "applyAccountCredit" to okBody,
            "getAccountCreditHistory" to historyBody(9500L),
        )
        c.setAmount("25")
        c.review(10000L)
        c.confirm()
        // The step is back on the form, so a second confirm has nothing to send.
        assertNull(c.confirm())
        assertEquals(1, sent().size)
    }
}
