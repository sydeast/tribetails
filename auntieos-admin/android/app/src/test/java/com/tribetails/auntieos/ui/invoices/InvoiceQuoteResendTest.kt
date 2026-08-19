package com.tribetails.auntieos.ui.invoices

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.data.contracts.GetInvoiceLedgerResult
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
 * ISSUE #448 on the admin Android app: a DECLINED quote gets a way forward, and
 * an ACCEPTED one says out loud that its figures are agreed and frozen.
 *
 * THE TEST THAT WOULD HAVE CAUGHT THE BUG is the first: before this, a decline
 * showed up on the amount card as one line of trend text ("quote declined by
 * the household") and there was nothing on the screen, or in the repo, that
 * could do anything about it.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class InvoiceQuoteResendTest {

    @get:Rule
    val rule = createComposeRule()

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    private lateinit var invoiceRepo: InvoiceRepository

    /**
     * [quoteDecision] is the stored answer: 'denied' as `denyQuote` leaves it
     * (status stays `quote`), 'accepted' as `acceptQuote` leaves it (status is
     * re-stamped `open` and the scope is locked), or null for one still out.
     */
    private fun mount(quoteDecision: String?, status: String = "quote", editScope: String = "all") {
        val invoice = Invoice(
            id = "inv1",
            kinfolkId = "fam1",
            kinfolkName = "Wanda Thorne",
            invoiceNumber = "Q-1001",
            client = "Wanda Thorne",
            date = "2026-08-01",
            dueDate = "2999-12-31",
            total = 240.00,
            amountDue = 240.00,
            status = status,
            editScope = editScope,
            quoteDecision = quoteDecision,
        )
        val repo = mockk<AuntieRepository>(relaxed = true)
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        invoiceRepo = mockk<InvoiceRepository>(relaxed = true)
        coEvery { invoiceRepo.getInvoiceById("inv1") } returns Result.success(invoice)
        coEvery { invoiceRepo.resendQuote("inv1") } returns Result.success("quote")
        coEvery { kinCareRepo.getKinCareSessionsForKinfolk(any()) } returns Result.success(emptyList())
        coEvery { repo.getBusinessSettings() } returns Result.success(BusinessSettings())
        coEvery { invoiceRepo.getInvoiceLedger("inv1") } returns Result.success(
            GetInvoiceLedgerResult(
                invoiceId = "inv1",
                payments = emptyList(),
                paidCents = 0L,
                totalCents = 24000L,
                amountDueCents = 24000L,
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
    fun `a declined quote offers Revise and resend, and it calls the callable`() {
        mount(quoteDecision = "denied")

        rule.onNodeWithText("DECLINED").assertIsDisplayed()
        rule.onNodeWithText("Revise and resend").assertIsDisplayed()

        rule.onNodeWithText("Revise and resend").performClick()
        rule.waitForIdle()

        coVerify(exactly = 1) { invoiceRepo.resendQuote("inv1") }
    }

    @Test
    fun `an accepted quote says its figures are locked and offers no resend`() {
        mount(quoteDecision = "accepted", status = "open", editScope = "none")

        rule.onNodeWithText("ACCEPTED").assertIsDisplayed()
        rule.onNodeWithText("Revise and resend").assertDoesNotExist()
    }

    @Test
    fun `a quote nobody has answered gets neither the banner nor the resend`() {
        mount(quoteDecision = null)

        rule.onNodeWithText("DECLINED").assertDoesNotExist()
        rule.onNodeWithText("ACCEPTED").assertDoesNotExist()
        rule.onNodeWithText("Revise and resend").assertDoesNotExist()
    }
}
