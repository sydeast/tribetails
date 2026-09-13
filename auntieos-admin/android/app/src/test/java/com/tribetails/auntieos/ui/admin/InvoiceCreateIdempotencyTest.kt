package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #825: the invoice, quote and standalone-payment keys, AuntieOS Android.
 *
 * WHAT A SECOND PRESS USED TO COST HERE. `createInvoice` and `createQuote` draw
 * the next number out of the shared `counters/invoiceNumber` sequence, so a
 * replay did not merely write a second document: it SPENT a sequence value, and
 * a consumed invoice number cannot be given back. `recordPayment` is worse — it
 * records the payment again and, with `autoApply`, credits the household's
 * `accountBalanceCents` again, and account balance is the only destination this
 * business has for money owed back, so the second credit is spendable money made
 * from nothing.
 *
 * The composer is where this matters most, and that is not incidental: a failed
 * `composeInvoice` deliberately leaves the dialog OPEN with the form intact so
 * the operator can press Create again. That press is the one the key exists for.
 *
 * Mirrors `auntieos-admin/src/screens/InvoiceCreate.test.tsx`, and follows
 * `MarketingBlastsViewModelTest` (#814) case for case.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class InvoiceCreateIdempotencyTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository
    private lateinit var invoiceRepo: InvoiceRepository
    private lateinit var kinCareRepo: KinCareRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        invoiceRepo = mockk()
        kinCareRepo = mockk()
        // The list refresh every successful write fires. Not what this is about.
        coEvery { invoiceRepo.getInvoices() } returns Result.success(emptyList())
        coEvery { invoiceRepo.listPayments(any(), any()) } returns
            Result.failure(RuntimeException("not under test"))
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun vm() = AdminDataViewModel(
        repository = repo,
        invoiceRepository = invoiceRepo,
        kinCareRepository = kinCareRepo,
    )

    private fun request(
        kind: InvoiceCreateKind = InvoiceCreateKind.INVOICE,
        total: Double = 120.0,
        sendToKinfolk: Boolean = false,
    ) = NewInvoiceRequest(
        kind = kind,
        invoice = TestFixtures.invoice1.copy(total = total, amountDue = total),
        sendToKinfolk = sendToKinfolk,
        termsCode = "net_14",
    )

    /** The `inv_` keys `createInvoice` was called with, in order. */
    private fun invoiceKeys(times: Int): List<String?> {
        val keys = mutableListOf<String?>()
        coVerify(exactly = times) {
            invoiceRepo.createInvoice(any(), any(), any(), any(), captureNullable(keys))
        }
        return keys
    }

    /** The `quot_` keys `createQuote` was called with, in order. */
    private fun quoteKeys(times: Int): List<String?> {
        val keys = mutableListOf<String?>()
        coVerify(exactly = times) {
            invoiceRepo.createQuote(any(), any(), any(), any(), any(), captureNullable(keys))
        }
        return keys
    }

    /** The `pay_` keys `recordPayment` was called with, in order. */
    private fun paymentKeys(times: Int): List<String?> {
        val keys = mutableListOf<String?>()
        coVerify(exactly = times) {
            invoiceRepo.createPayment(any(), captureNullable(keys))
        }
        return keys
    }

    // ── composeInvoice ───────────────────────────────────────────────────────

    @Test
    fun `one key is minted and held across the operator's own retry of one invoice`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.createInvoice(any(), any(), any(), any(), any()) } returns
                Result.failure(RuntimeException("internal")) andThen
                Result.success("inv-1")
            val v = vm()
            val r = request()

            v.composeInvoice(r)
            advanceUntilIdle()
            v.composeInvoice(r)
            advanceUntilIdle()

            val keys = invoiceKeys(2)
            assertTrue(keys[0]!!.matches(Regex("^inv_\\d+_[a-z0-9]+$")))
            assertEquals(keys[0], keys[1])
        }

    @Test
    fun `an edited invoice mints a new key, because it is a different bill`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.createInvoice(any(), any(), any(), any(), any()) } returns
                Result.failure(RuntimeException("internal")) andThen
                Result.success("inv-2")
            val v = vm()

            v.composeInvoice(request(total = 120.0))
            advanceUntilIdle()
            // The failure left the dialog open; the operator fixes the total and
            // presses again. A held key would replay the first attempt and report
            // the $120 invoice back as though the correction had landed.
            v.composeInvoice(request(total = 250.0))
            advanceUntilIdle()

            assertNotEquals(invoiceKeys(2)[0], invoiceKeys(2)[1])
        }

    @Test
    fun `a created invoice releases the key, so the next one is its own bill`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.createInvoice(any(), any(), any(), any(), any()) } returns
                Result.success("inv-1")
            val v = vm()
            val r = request()

            v.composeInvoice(r)
            advanceUntilIdle()
            v.composeInvoice(r)
            advanceUntilIdle()

            // Identical request, but the first one landed: a household can be
            // billed the same amount for two different weeks of work, and holding
            // the key would hand back the first invoice as though a second had
            // been made.
            assertNotEquals(invoiceKeys(2)[0], invoiceKeys(2)[1])
        }

    /**
     * THE PREFIX FOLLOWS THE KIND, and it has to: both callables write into the
     * same `invoices` collection, and the server refuses an `inv_` key at
     * `createQuote` outright. An operator who flips the composer from Invoice to
     * Quote and presses again must get a fresh `quot_` key, not a replay.
     */
    @Test
    fun `switching the composer from invoice to quote re-mints under the quote prefix`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.createInvoice(any(), any(), any(), any(), any()) } returns
                Result.failure(RuntimeException("internal"))
            coEvery { invoiceRepo.createQuote(any(), any(), any(), any(), any(), any()) } returns
                Result.success("q-1")
            val v = vm()

            v.composeInvoice(request(kind = InvoiceCreateKind.INVOICE))
            advanceUntilIdle()
            v.composeInvoice(request(kind = InvoiceCreateKind.QUOTE))
            advanceUntilIdle()

            val invoiceKey = invoiceKeys(1)[0]!!
            val quoteKey = quoteKeys(1)[0]!!
            assertTrue(invoiceKey.startsWith("inv_"))
            assertTrue(quoteKey.startsWith("quot_"))
            assertNotEquals(invoiceKey, quoteKey)
        }

    @Test
    fun `a quote holds its key across a retry too, and the household gets one quote`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.createQuote(any(), any(), any(), any(), any(), any()) } returns
                Result.failure(RuntimeException("internal")) andThen
                Result.success("q-1")
            val v = vm()
            val r = request(kind = InvoiceCreateKind.QUOTE, sendToKinfolk = true)

            v.composeInvoice(r)
            advanceUntilIdle()
            v.composeInvoice(r)
            advanceUntilIdle()

            val keys = quoteKeys(2)
            assertTrue(keys[0]!!.matches(Regex("^quot_\\d+_[a-z0-9]+$")))
            // With sendToKinfolk the key is protecting the household's inbox as
            // well as the collection: a replay would dispatch the issued-quote
            // notification a second time.
            assertEquals(keys[0], keys[1])
        }

    // ── the plain createInvoice / createQuote entry points ───────────────────

    @Test
    fun `the plain createInvoice entry point holds its key across a retry`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.createInvoice(any(), any(), any(), any(), any()) } returns
                Result.failure(RuntimeException("internal")) andThen
                Result.success("inv-1")
            val v = vm()

            v.createInvoice(TestFixtures.invoice1)
            advanceUntilIdle()
            v.createInvoice(TestFixtures.invoice1)
            advanceUntilIdle()

            val keys = invoiceKeys(2)
            assertTrue(keys[0]!!.startsWith("inv_"))
            assertEquals(keys[0], keys[1])
        }

    @Test
    fun `the plain createQuote entry point holds its key across a retry`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.createQuote(any(), any(), any(), any(), any(), any()) } returns
                Result.failure(RuntimeException("internal")) andThen
                Result.success("q-1")
            val v = vm()

            v.createQuote(TestFixtures.invoice1, sendToKinfolk = true)
            advanceUntilIdle()
            v.createQuote(TestFixtures.invoice1, sendToKinfolk = true)
            advanceUntilIdle()

            val keys = quoteKeys(2)
            assertTrue(keys[0]!!.startsWith("quot_"))
            assertEquals(keys[0], keys[1])
        }

    /**
     * `sendToKinfolk` decides whether a real household hears about this quote, so
     * flipping it is a different submission even when every other field matches.
     */
    @Test
    fun `flipping sendToKinfolk re-mints, because it decides whether mail goes out`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.createQuote(any(), any(), any(), any(), any(), any()) } returns
                Result.failure(RuntimeException("internal")) andThen
                Result.success("q-1")
            val v = vm()

            v.createQuote(TestFixtures.invoice1, sendToKinfolk = false)
            advanceUntilIdle()
            v.createQuote(TestFixtures.invoice1, sendToKinfolk = true)
            advanceUntilIdle()

            assertNotEquals(quoteKeys(2)[0], quoteKeys(2)[1])
        }

    // ── the standalone payment ledger ────────────────────────────────────────

    @Test
    fun `a standalone payment holds one key across the operator's retry`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.createPayment(any(), any()) } returns
                Result.failure(RuntimeException("internal")) andThen
                Result.success("pay-1")
            val v = vm()

            v.createPayment(TestFixtures.payment1)
            advanceUntilIdle()
            v.createPayment(TestFixtures.payment1)
            advanceUntilIdle()

            val keys = paymentKeys(2)
            assertTrue(keys[0]!!.matches(Regex("^pay_\\d+_[a-z0-9]+$")))
            assertEquals(keys[0], keys[1])
        }

    @Test
    fun `a corrected amount mints a new key, because it is a different payment`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.createPayment(any(), any()) } returns
                Result.failure(RuntimeException("internal")) andThen
                Result.success("pay-1")
            val v = vm()

            v.createPayment(TestFixtures.payment1.copy(amount = 80.0))
            advanceUntilIdle()
            v.createPayment(TestFixtures.payment1.copy(amount = 95.0))
            advanceUntilIdle()

            assertNotEquals(paymentKeys(2)[0], paymentKeys(2)[1])
        }

    /**
     * The two holders are separate on purpose: the composer and the payment
     * ledger live on the same screen and can both be mid-submission, and a shared
     * holder would have each one's key re-minted by the other's first press.
     */
    @Test
    fun `a payment in flight does not disturb the invoice key being held beside it`() =
        runTest(testDispatcher) {
            coEvery { invoiceRepo.createInvoice(any(), any(), any(), any(), any()) } returns
                Result.failure(RuntimeException("internal")) andThen
                Result.success("inv-1")
            coEvery { invoiceRepo.createPayment(any(), any()) } returns
                Result.failure(RuntimeException("internal"))
            val v = vm()
            val r = request()

            v.composeInvoice(r)
            advanceUntilIdle()
            v.createPayment(TestFixtures.payment1)
            advanceUntilIdle()
            v.composeInvoice(r)
            advanceUntilIdle()

            val keys = invoiceKeys(2)
            assertEquals(keys[0], keys[1])
        }
}
