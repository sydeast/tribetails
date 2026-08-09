package com.tribetails.auntieos.ui.invoices

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.tribetails.auntieos.data.contracts.GetInvoiceLedgerResult
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * THE CHARGEBACK PANEL ON THE STAFF PHONE.
 *
 * A dispute deliberately leaves the invoice paid and its balance at zero
 * (`functions/src/billing/stripeDispute.ts`: un-paying it would restart the
 * reminder cron against a household over their own bank's action). So this
 * screen keeps rendering a green PAID pill over money that may already be gone,
 * and the panel pinned here is the only thing that says otherwise.
 *
 * The case that matters most is the WON one. Nothing ever clears
 * `disputeStatus`, so an invoice disputed once carries it forever; a screen that
 * alarmed on any non-empty status would show every previously-disputed invoice
 * as permanently on fire.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
// TALL viewport, same reason as InvoiceDetailPaymentUnitsTest: the body is a
// LazyColumn and anything below the fold never composes.
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class InvoiceDetailDisputeTest {

    @get:Rule
    val rule = createComposeRule()

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    /** The alarm heading. Its ABSENCE is what "reads as history" means here. */
    private val alarmTitle = "This payment is being taken back"
    private val historyTitle = "Dispute won"

    private fun mount(
        disputeStatus: String? = null,
        disputeFundsState: String? = null,
        disputeAmountCents: Long? = null,
        disputeId: String? = null,
    ) {
        val invoice = Invoice(
            id = "inv1",
            kinfolkId = "fam1",
            kinfolkName = "Wanda Thorne",
            invoiceNumber = "1029",
            client = "Wanda Thorne",
            date = "2026-07-20",
            total = 40.00,
            amountDue = 0.0,
            paidCents = 4000L,
            status = "paid",
            editScope = "none",
            disputeStatus = disputeStatus,
            disputeFundsState = disputeFundsState,
            disputeAmountCents = disputeAmountCents,
            disputeId = disputeId,
        )
        val repo = mockk<AuntieRepository>(relaxed = true)
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        val invoiceRepo = mockk<InvoiceRepository>(relaxed = true)
        coEvery { invoiceRepo.getInvoiceById("inv1") } returns Result.success(invoice)
        coEvery { kinCareRepo.getKinCareSessionsForKinfolk(any()) } returns Result.success(emptyList())
        coEvery { repo.getBusinessSettings() } returns Result.success(BusinessSettings())
        coEvery { invoiceRepo.getInvoiceLedger("inv1") } returns Result.success(
            GetInvoiceLedgerResult(
                invoiceId = "inv1",
                payments = emptyList(),
                paidCents = 4000L,
                totalCents = 4000L,
                amountDueCents = 0L,
                ledgerPayments = emptyList(),
                unlinkedKinfolkPayments = emptyList(),
                unresolvedAmountCount = 0L,
                sessions = emptyList(),
                missingSessionIds = emptyList(),
                orphanSessionIds = emptyList(),
                truncated = false,
            ),
        )
        val vm = InvoiceDetailViewModel(
            repository = repo,
            invoiceRepository = invoiceRepo,
            kinCareRepository = kinCareRepo,
        )
        rule.setContent {
            AuntieOSTheme {
                InvoiceDetailScreen(invoiceId = "inv1", onBack = {}, viewModel = vm)
            }
        }
        rule.waitForIdle()
    }

    /**
     * The tone mapping itself, pinned separately: the rendered banner colour is
     * not readable through the semantics tree, so the one branch that decides it
     * is asserted directly rather than inferred from a screenshot.
     */
    @Test
    fun `tone follows the open flag and nothing else`() {
        assertEquals(AuntieBannerTone.Error, invoiceDisputeTone(open = true))
        assertEquals(AuntieBannerTone.Info, invoiceDisputeTone(open = false))
    }

    @Test
    fun `an open chargeback says so, with the raw status and the disputed amount`() {
        mount(disputeStatus = "needs_response", disputeAmountCents = 4000L, disputeId = "dp_1")
        rule.onNodeWithText(alarmTitle).assertIsDisplayed()
        rule.onNode(hasText("needs_response", substring = true)).assertExists()
        // The whole sentence, not the bare "$40.00": the invoice total card on
        // this same screen also reads $40.00, and a bare match would pass off
        // the card while proving nothing about the panel.
        rule.onNode(hasText("The bank is disputing $40.00", substring = true)).assertExists()
        rule.onNode(hasText("still reads paid", substring = true)).assertExists()
    }

    /** THE ONE THE OPERATOR ASKED FOR. */
    @Test
    fun `a won dispute reads as history, not as an open problem`() {
        mount(disputeStatus = "won", disputeAmountCents = 4000L, disputeFundsState = "reinstated", disputeId = "dp_1")
        rule.onNodeWithText(historyTitle).assertIsDisplayed()
        rule.onNodeWithText(alarmTitle).assertDoesNotExist()
        rule.onNode(hasText("resolved in your favor", substring = true)).assertExists()
    }

    @Test
    fun `a won dispute whose funds are still out says so without raising an alarm`() {
        mount(disputeStatus = "won", disputeFundsState = "withdrawn")
        rule.onNodeWithText(historyTitle).assertIsDisplayed()
        rule.onNodeWithText(alarmTitle).assertDoesNotExist()
        rule.onNode(hasText("not been reported back", substring = true)).assertExists()
    }

    /** The funds lane can land first, leaving moved money and no status at all. */
    @Test
    fun `a withdrawal that beat the status renders, and says the status is unknown`() {
        mount(disputeFundsState = "withdrawn", disputeId = "dp_1")
        rule.onNodeWithText(alarmTitle).assertIsDisplayed()
        rule.onNode(hasText("not said where the dispute stands", substring = true)).assertExists()
    }

    /**
     * Two money rules meet here: an absent disputed amount must not print as
     * $0.00, and no debit total may be printed at all, because what leaves the
     * balance is the disputed amount plus Stripe's dispute fee and only the
     * first is on the object.
     */
    @Test
    fun `an unknown disputed amount is named in words, never as zero dollars`() {
        mount(disputeStatus = "lost")
        rule.onNodeWithText(alarmTitle).assertIsDisplayed()
        rule.onNode(hasText("did not carry an amount", substring = true)).assertExists()
        // Scoped to the panel's own figure clause. A bare "$0.00" would match the
        // Amount due card — which correctly reads $0.00, because a dispute does
        // not un-pay the invoice. The panel has exactly one way to print a
        // figure, and this proves it did not take it.
        rule.onNode(hasText("The bank is disputing", substring = true)).assertDoesNotExist()
    }

    @Test
    fun `a withdrawal names the dispute fee rather than inventing the debit`() {
        mount(disputeStatus = "lost", disputeAmountCents = 4000L, disputeFundsState = "withdrawn")
        rule.onNode(hasText("dispute fee", substring = true)).assertExists()
    }

    @Test
    fun `an invoice that was never disputed shows no panel of either kind`() {
        mount()
        rule.onNodeWithText(alarmTitle).assertDoesNotExist()
        rule.onNodeWithText(historyTitle).assertDoesNotExist()
    }
}
