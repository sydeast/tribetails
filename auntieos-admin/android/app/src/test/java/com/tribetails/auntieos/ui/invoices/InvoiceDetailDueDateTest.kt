package com.tribetails.auntieos.ui.invoices

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import com.tribetails.auntieos.data.contracts.GetInvoiceLedgerResult
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import java.util.Locale
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * THE DUE DATE ON THE CARD THAT CHASES THE MONEY.
 *
 * The "Amount due" stat card's second line is the one sentence on this screen
 * that tells the operator WHEN. It read `invoice.dueDate.trim().take(10)`, a bet
 * on `YYYY-MM-DD` that this field does not honour: `invoices.dueDate` is free
 * text, PR #241 confirmed the shape in production, and the web renderer treats
 * it as possibly unparseable throughout (`isInvoiceOverdue` returns false rather
 * than guessing).
 *
 * WHICH BRANCH WAS ACTUALLY LYING, checked rather than assumed. `past due` is
 * reached only when [com.tribetails.auntieos.domain.invoiceIsOverdue] is true,
 * and that gate already requires a readable ISO prefix, so free text could never
 * reach it - the worst it printed there was a raw `2026-07-01`. The `due` branch
 * has NO such gate, and free text lands in it precisely BECAUSE it is
 * unreadable: an invoice due "February 17, 2026" is never overdue, so it always
 * took that path and always read `due February 1`. Both branches are pinned
 * here; only the second was wrong about a day.
 *
 * These assert RENDERED STRINGS, because the rendered string is the defect.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class InvoiceDetailDueDateTest {

    @get:Rule
    val rule = createComposeRule()

    // The card spells the date for the operator's locale, so the expected
    // spelling is pinned rather than inherited from whatever machine runs CI.
    private val hostLocale = Locale.getDefault()

    @Before fun setUp() {
        Locale.setDefault(Locale.US)
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After fun tearDown() {
        Dispatchers.resetMain()
        Locale.setDefault(hostLocale)
    }

    private fun invoice(dueDate: String, status: String = "open") = Invoice(
        id = "inv1",
        kinfolkId = "fam1",
        kinfolkName = "Wanda Thorne",
        invoiceNumber = "1029",
        client = "Wanda Thorne",
        date = "2026-07-20",
        dueDate = dueDate,
        total = 300.00,
        amountDue = 44.44,
        status = status,
    )

    private val emptyLedger = GetInvoiceLedgerResult(
        invoiceId = "inv1",
        payments = emptyList(),
        paidCents = 0L,
        totalCents = 30000L,
        amountDueCents = 4444L,
        ledgerPayments = emptyList(),
        unlinkedKinfolkPayments = emptyList(),
        unresolvedAmountCount = 0L,
        sessions = emptyList(),
        missingSessionIds = emptyList(),
        orphanSessionIds = emptyList(),
        truncated = false,
    )

    private fun mount(invoice: Invoice) {
        val repo = mockk<AuntieRepository>(relaxed = true)
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        val invoiceRepo = mockk<InvoiceRepository>(relaxed = true)
        coEvery { invoiceRepo.getInvoiceById("inv1") } returns Result.success(invoice)
        coEvery { kinCareRepo.getKinCareSessionsForKinfolk(any()) } returns Result.success(emptyList())
        coEvery { repo.getBusinessSettings() } returns Result.success(BusinessSettings())
        coEvery { invoiceRepo.getInvoiceLedger("inv1") } returns Result.success(emptyLedger)
        val viewModel = InvoiceDetailViewModel(
            repository = repo,
            invoiceRepository = invoiceRepo,
            kinCareRepository = kinCareRepo,
        )
        rule.setContent {
            AuntieOSTheme {
                InvoiceDetailScreen(invoiceId = "inv1", onBack = {}, viewModel = viewModel)
            }
        }
        rule.waitForIdle()
    }

    @Test
    fun `an operator-typed due date is shown whole, not chopped into a different day`() {
        // The live defect. "February 17, 2026" is unreadable as a date, so this
        // invoice is never overdue and always took the `due` branch, where ten
        // characters of it read "due February 1" - a real day, sixteen days
        // early, on the line that tells her when to chase.
        mount(invoice(dueDate = "February 17, 2026"))
        rule.onNodeWithText("due February 17, 2026").assertExists()
        rule.onNodeWithText("due February 1").assertDoesNotExist()
    }

    @Test
    fun `a stored ISO due date is spelled out instead of left as machine text`() {
        // Fixed and long past, so the overdue verdict does not depend on the day
        // the suite runs: `todayKey` is the real clock inside the composable.
        mount(invoice(dueDate = "2020-01-01"))
        rule.onNodeWithText("past due Jan 1, 2020").assertExists()
        rule.onNodeWithText("past due 2020-01-01").assertDoesNotExist()
    }

    @Test
    fun `an ISO instant due date keeps its stored day and loses only the clock`() {
        mount(invoice(dueDate = "2020-01-01T23:45:00Z"))
        rule.onNodeWithText("past due Jan 1, 2020").assertExists()
    }

    @Test
    fun `an ambiguous slash due date is printed as stored, not decided for her`() {
        // 07/01 could be July 1st or January 7th. It is also unreadable to the
        // overdue gate, so this invoice reads as merely due - which is the
        // honest answer when nobody can tell what day was meant.
        mount(invoice(dueDate = "07/01/2020"))
        rule.onNodeWithText("due 07/01/2020").assertExists()
    }

    @Test
    fun `an invoice with no due date says due soon rather than trailing off`() {
        // A blank dueDate cannot be overdue either, so "past due" with nothing
        // after it is unreachable. This pins that it stays that way.
        mount(invoice(dueDate = ""))
        rule.onNodeWithText("due soon").assertExists()
        rule.onNodeWithText("past due").assertDoesNotExist()
    }
}
