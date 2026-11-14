package com.tribetails.auntieos.ui.invoices

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.data.contracts.ConvertQuoteToInvoiceResult
import com.tribetails.auntieos.data.contracts.GetInvoiceLedgerResult
import com.tribetails.auntieos.data.contracts.WithdrawQuoteResult
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * #2087 / #2088 on the admin Android app: a quote saved unsent offers Send
 * quote (its draft send goes out as a quote), and once a quote exists the
 * office can turn it into an invoice or withdraw it, each behind a confirm.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class InvoiceQuoteLifecycleTest {

    @get:Rule
    val rule = createComposeRule()

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    private lateinit var invoiceRepo: InvoiceRepository

    private fun mount(status: String, quoteDraft: Boolean? = null, quoteDecision: String? = null) {
        val invoice = Invoice(
            id = "inv1",
            kinfolkId = "fam1",
            kinfolkName = "Wanda Thorne",
            invoiceNumber = "Q-1001",
            client = "Wanda Thorne",
            date = "2026-08-01",
            dueDate = "2026-08-01",
            total = 240.00,
            amountDue = 240.00,
            status = status,
            editScope = "all",
            quoteDecision = quoteDecision,
            quoteDraft = quoteDraft,
        )
        val repo = mockk<AuntieRepository>(relaxed = true)
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        invoiceRepo = mockk<InvoiceRepository>(relaxed = true)
        coEvery { invoiceRepo.getInvoiceById("inv1") } returns Result.success(invoice)
        coEvery { invoiceRepo.convertQuoteToInvoice("inv1") } returns Result.success(
            ConvertQuoteToInvoiceResult(ok = true, invoiceId = "inv1", status = "draft"),
        )
        coEvery { invoiceRepo.withdrawQuote("inv1") } returns Result.success(
            WithdrawQuoteResult(ok = true, invoiceId = "inv1", status = "cancelled", releasedSessionIds = listOf("s1")),
        )
        coEvery { kinCareRepo.getKinCareSessionsForKinfolk(any()) } returns Result.success(emptyList())
        coEvery { repo.getBusinessSettings() } returns Result.success(BusinessSettings())
        coEvery { invoiceRepo.getInvoiceLedger("inv1") } returns Result.success(
            GetInvoiceLedgerResult(
                invoiceId = "inv1",
                payments = emptyList(),
                paidCents = 0L,
                totalCents = 24000L,
                amountDueCents = 24000L,
                writeOffs = emptyList(),
                writtenOffCents = 0L,
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

    @Test
    fun `a quote saved unsent says the household cannot see it and offers Send quote, not Review and send`() {
        mount(status = "draft", quoteDraft = true)
        rule.onNodeWithText("DRAFT QUOTE").assertIsDisplayed()
        rule.onNodeWithText("Send quote").assertIsDisplayed()
        rule.onNodeWithText("Review and send").assertDoesNotExist()
        rule.onNodeWithText("Turn into invoice").assertIsDisplayed()
        rule.onNodeWithText("Withdraw quote").assertIsDisplayed()
    }

    @Test
    fun `an ordinary draft keeps Review and send and offers no quote actions`() {
        mount(status = "draft")
        rule.onNodeWithText("Review and send").assertIsDisplayed()
        rule.onNodeWithText("Turn into invoice").assertDoesNotExist()
        rule.onNodeWithText("Withdraw quote").assertDoesNotExist()
    }

    @Test
    fun `Turn into invoice confirms first, then calls the callable once`() {
        mount(status = "quote")
        rule.onNodeWithText("Turn into invoice").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Turn this quote into an invoice?").assertIsDisplayed()
        coVerify(exactly = 0) { invoiceRepo.convertQuoteToInvoice(any()) }
        // The dialog's button, the second "Turn into invoice" on screen.
        rule.onAllNodesWithText("Turn into invoice")[1].performClick()
        rule.waitForIdle()
        coVerify(exactly = 1) { invoiceRepo.convertQuoteToInvoice("inv1") }
    }

    @Test
    fun `Withdraw quote confirms first, then calls the callable once`() {
        mount(status = "quote")
        rule.onNodeWithText("Withdraw quote").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Withdraw this quote?").assertIsDisplayed()
        rule.onAllNodesWithText("Withdraw quote")[1].performClick()
        rule.waitForIdle()
        coVerify(exactly = 1) { invoiceRepo.withdrawQuote("inv1") }
    }

    @Test
    fun `an accepted quote offers neither`() {
        mount(status = "open", quoteDecision = "accepted")
        rule.onNodeWithText("Turn into invoice").assertDoesNotExist()
        rule.onNodeWithText("Withdraw quote").assertDoesNotExist()
    }
}
