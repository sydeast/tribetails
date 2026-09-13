package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.Payment
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.mintInvoiceIdempotencyKey
import com.tribetails.auntieos.web.data.mintInvoicePaymentIdempotencyKey
import com.tribetails.auntieos.web.data.mintPaymentIdempotencyKey
import com.tribetails.auntieos.web.data.mintQuoteIdempotencyKey
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * #825: the three money writes this console can make carry the caller's key.
 *
 * WHAT THIS GUARDS. `recordPayment` wrote an auto-id row into `payments`, and
 * `createInvoice` / `createQuote` each drew a value from the shared
 * `counters/invoiceNumber` sequence. So a second attempt at one submission --
 * which is the ordinary thing to do when the first attempt reports a failure
 * this console cannot classify -- recorded the money twice, or burned a second
 * invoice number on a duplicate. Neither is recoverable by an operator: by
 * standing ruling the account balance is the only destination this business has
 * for money owed back, and a consumed sequence value cannot be handed back at
 * all.
 *
 * HOW IT ASSERTS WITHOUT A NETWORK. Two seams, both already here for this.
 * `createInvoice` and `createQuote` go through `platformInvokeCallable`, whose
 * jvm actual records the payload on `JvmFirestoreFixtures.lastCallablePayloadJson`
 * (NOTE-53); `MultiDateBookingClientTest` asserts #644's key the same way.
 * `recordPayment` does NOT go through a callable on this surface -- it is a
 * direct REST write -- so it is checked on `JvmFirestoreFixtures.lastWrite`,
 * which `JvmFirestoreRest` stamps before it fetches a token, exactly as #616 set
 * up for the desktop template delete. No token exists under test, so no call
 * leaves the process; the intent is captured, and the intent is the thing.
 *
 * jvm IS the desktop target (#513 retired wasm), so this is the shipped path.
 */
class MoneyIdempotencyClientTest {

    @AfterTest
    fun tearDown() { JvmFirestoreFixtures.clear() }

    private fun invoice() = Invoice(
        kinfolkId = "kf1",
        kinfolkName = "Halbrook Household",
        invoiceNumber = "INV-9",
        total = 120.0,
        amountDue = 120.0,
        status = "sent",
    )

    private fun payment() = Payment(
        kinfolkId = "kf1",
        kinfolkName = "Halbrook Household",
        date = "2026-09-13",
        paymentMethod = "cash",
        amount = 120.0,
        invoiceId = "inv_1",
        invoiceNumber = "INV-9",
    )

    // ── createInvoice ────────────────────────────────────────────────────────

    @Test
    fun createInvoiceSendsTheKeyWhenTheCallerSuppliesOne() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("createInvoice" to """{"ok":true,"invoiceId":"inv_1757000000000_a1b2c3"}""")
        FirestoreClient().createInvoice(invoice(), idempotencyKey = "inv_1757000000000_a1b2c3")
        assertEquals("createInvoice", JvmFirestoreFixtures.lastCallableName)
        assertTrue(
            JvmFirestoreFixtures.lastCallablePayloadJson.orEmpty()
                .contains("\"idempotencyKey\":\"inv_1757000000000_a1b2c3\""),
        )
    }

    @Test
    fun createInvoiceOmitsTheKeyEntirelyWhenTheCallerHasNone() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("createInvoice" to """{"ok":true,"invoiceId":"inv_1"}""")
        FirestoreClient().createInvoice(invoice())
        // Absent, not null: the callable's zod guard refuses an explicit null,
        // and an unkeyed create must behave exactly as it did before #825 --
        // server-minted id, no dedupe.
        assertTrue(!JvmFirestoreFixtures.lastCallablePayloadJson.orEmpty().contains("idempotencyKey"))
    }

    // ── createQuote ──────────────────────────────────────────────────────────

    @Test
    fun createQuoteSendsTheKeyAlongsideSendToKinfolk() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("createQuote" to """{"ok":true,"invoiceId":"quot_1757000000000_z9y8x7"}""")
        FirestoreClient().createQuote(invoice(), sendToKinfolk = true, idempotencyKey = "quot_1757000000000_z9y8x7")
        val payload = JvmFirestoreFixtures.lastCallablePayloadJson.orEmpty()
        assertEquals("createQuote", JvmFirestoreFixtures.lastCallableName)
        assertTrue(payload.contains("\"idempotencyKey\":\"quot_1757000000000_z9y8x7\""))
        // Both on the wire together: the send flag is part of the submission the
        // key names, not a modifier applied on top of a replay.
        assertTrue(payload.contains("\"sendToKinfolk\":true"))
    }

    @Test
    fun createQuoteOmitsTheKeyEntirelyWhenTheCallerHasNone() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("createQuote" to """{"ok":true,"invoiceId":"q_1"}""")
        FirestoreClient().createQuote(invoice(), sendToKinfolk = false)
        assertTrue(!JvmFirestoreFixtures.lastCallablePayloadJson.orEmpty().contains("idempotencyKey"))
    }

    // ── recordPayment (direct REST, not a callable) ──────────────────────────

    @Test
    fun recordPaymentWritesTheKeyedDocumentWhenTheCallerSuppliesAKey() = runBlocking {
        FirestoreClient().recordPayment(payment(), idempotencyKey = "pay_1757000000000_a1b2c3")

        val write = assertNotNull(JvmFirestoreFixtures.lastWrite, "no REST write was attempted")
        assertEquals("PATCH", write.op)
        assertEquals("payments", write.collection)
        // THE assertion of this file. The id is the caller's key, so the second
        // attempt at one payment addresses the first attempt's row instead of
        // asking Firestore for a new one.
        assertEquals("pay_1757000000000_a1b2c3", write.id)
    }

    @Test
    fun twoAttemptsAtOnePaymentAddressOneRow() = runBlocking {
        val key = "pay_1757000000000_a1b2c3"
        FirestoreClient().recordPayment(payment(), idempotencyKey = key)
        val first = assertNotNull(JvmFirestoreFixtures.lastWrite)
        FirestoreClient().recordPayment(payment(), idempotencyKey = key)
        val second = assertNotNull(JvmFirestoreFixtures.lastWrite)

        // Same document, both times. This is the whole of #825 on this surface:
        // before it, two presses were two rows in `payments` for money that
        // arrived once, and nothing downstream could tell them apart.
        assertEquals(first.collection, second.collection)
        assertEquals(first.id, second.id)
        assertEquals("PATCH", second.op)
    }

    @Test
    fun recordPaymentWithoutAKeyStillPostsAnAutoIdRow() = runBlocking {
        FirestoreClient().recordPayment(payment())

        val write = assertNotNull(JvmFirestoreFixtures.lastWrite)
        // The pre-#825 behaviour, deliberately unchanged for a caller that has
        // no key: POST to the collection, Firestore mints the id, nothing is
        // deduplicated. Pinned so the unkeyed path cannot be "tidied" into a
        // keyed one that silently invents an id.
        assertEquals("POST", write.op)
        assertEquals("payments", write.collection)
        assertEquals("", write.id)
    }

    @Test
    fun aPaymentWriteWithoutCredentialsFailsLoudRatherThanReportingSuccess() = runBlocking {
        // No auth token under test, so the REST call cannot be made. Pinned
        // because the keyed branch is new code on a money path: it must report
        // the failure, not swallow it and let the operator believe the payment
        // is stored.
        val r = FirestoreClient().recordPayment(payment(), idempotencyKey = "pay_1757000000000_a1b2c3")
        assertTrue(r !is WriteResult.Ok)
    }

    // ── key shapes ───────────────────────────────────────────────────────────

    /**
     * The server refuses anything that is not this shape with `invalid-argument`
     * (`sendIdempotencyKeyRe` in `mytribe/functions/src/lib/sendIdempotency.ts`,
     * which `moneyIdempotency.ts` imports rather than restating). A bare uuid
     * would be rejected, so the prefix and the shape are the contract, not
     * decoration. `ipay_` is here even though nothing in this console calls
     * `markInvoicePaid` yet -- minting it wrong is a failure that would only
     * surface on the day a screen wires that callable up.
     */
    @Test
    fun everyMinterProducesTheShapeTheServerAccepts() {
        fun re(prefix: String) = Regex("^${prefix}_[0-9]{10,16}_[a-z0-9]{1,16}$")
        assertTrue(re("pay").matches(mintPaymentIdempotencyKey()))
        assertTrue(re("ipay").matches(mintInvoicePaymentIdempotencyKey()))
        assertTrue(re("inv").matches(mintInvoiceIdempotencyKey()))
        assertTrue(re("quot").matches(mintQuoteIdempotencyKey()))
    }

    /**
     * `pay_` must not satisfy the `ipay_` guard or vice versa. They are separate
     * prefixes because they name rows in two different collections, and a key
     * that passes the wrong callable's guard would write the right shape into
     * the wrong place.
     */
    @Test
    fun thePrefixesDoNotCollide() {
        val keys = listOf(
            mintPaymentIdempotencyKey(),
            mintInvoicePaymentIdempotencyKey(),
            mintInvoiceIdempotencyKey(),
            mintQuoteIdempotencyKey(),
        )
        val prefixes = keys.map { it.substringBefore('_') }
        assertEquals(listOf("pay", "ipay", "inv", "quot"), prefixes)
    }

    /** A second mint is a different key, or holding one per submission means nothing. */
    @Test
    fun twoMintsDiffer() {
        assertTrue(mintPaymentIdempotencyKey() != mintPaymentIdempotencyKey())
    }
}
