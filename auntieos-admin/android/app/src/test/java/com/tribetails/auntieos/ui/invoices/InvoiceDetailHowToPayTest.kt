package com.tribetails.auntieos.ui.invoices

import androidx.compose.ui.test.hasText
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
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * #1200: the "How to pay" panel on the Android invoice detail screen shows
 * what the household is offered, not every handle that happens to be filled
 * in. The resolution rules are pinned in `HowToPayRowsTest`; this pins that
 * the screen renders them, through the real view model and settings read.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1080dp-h8000dp-xhdpi")
class InvoiceDetailHowToPayTest {

    @get:Rule
    val rule = createComposeRule()

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    private fun invoice(status: String = "open", snapshot: Any? = null) = Invoice(
        id = "inv1",
        kinfolkId = "fam1",
        kinfolkName = "Wanda Thorne",
        invoiceNumber = "1029",
        client = "Wanda Thorne",
        date = "2026-07-20",
        dueDate = "2026-08-20",
        total = 60.00,
        amountDue = 60.00,
        status = status,
        payMethodSettingsSnapshot = snapshot,
    )

    private val ledger = GetInvoiceLedgerResult(
        invoiceId = "inv1",
        payments = emptyList(),
        paidCents = 0L,
        totalCents = 6000L,
        amountDueCents = 6000L,
        ledgerPayments = emptyList(),
        unlinkedKinfolkPayments = emptyList(),
        unresolvedAmountCount = 0L,
        sessions = emptyList(),
        missingSessionIds = emptyList(),
        orphanSessionIds = emptyList(),
        truncated = false,
    )

    /** Venmo switched off with its handle kept; Zelle switched on with instructions. */
    private val settings = BusinessSettings(
        venmoHandle = "@tribetails",
        paymentOptions = mapOf(
            "venmo" to mapOf("enabled" to false, "instructions" to ""),
            "zelle" to mapOf("enabled" to true, "instructions" to "Zelle to the business line."),
        ),
    )

    private fun mount(invoice: Invoice) {
        val repo = mockk<AuntieRepository>(relaxed = true)
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        val invoiceRepo = mockk<InvoiceRepository>(relaxed = true)
        coEvery { invoiceRepo.getInvoiceById("inv1") } returns Result.success(invoice)
        coEvery { kinCareRepo.getKinCareSessionsForKinfolk(any()) } returns Result.success(emptyList())
        coEvery { repo.getBusinessSettings() } returns Result.success(settings)
        coEvery { invoiceRepo.getInvoiceLedger("inv1") } returns Result.success(ledger)
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
    fun `the panel lists the offered methods and hides a switched-off handle`() {
        mount(invoice())
        rule.waitUntil(10_000) { rule.onAllNodes(hasText("How to pay")).fetchSemanticsNodes().isNotEmpty() }
        // Row labels render upper-cased (AuntieKeyValueRow), so the label lookup ignores case.
        rule.onNodeWithText("Credit card", ignoreCase = true).assertExists()
        rule.onNodeWithText("In the portal").assertExists()
        rule.onNodeWithText("Zelle to the business line.").assertExists()
        rule.onNodeWithText("@tribetails").assertDoesNotExist()
    }

    @Test
    fun `the invoice snapshot decides, not today's settings`() {
        val snapshot = mapOf(
            "venmoHandle" to "@issued",
            "paymentOptions" to mapOf("stripe" to mapOf("enabled" to false), "venmo" to mapOf("enabled" to true)),
        )
        mount(invoice(snapshot = snapshot))
        rule.waitUntil(10_000) { rule.onAllNodes(hasText("How to pay")).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("@issued").assertExists()
        rule.onNodeWithText("Zelle to the business line.").assertDoesNotExist()
        rule.onNodeWithText("Credit card", ignoreCase = true).assertDoesNotExist()
        rule.onNodeWithText("In the portal").assertDoesNotExist()
    }

    @Test
    fun `a paid invoice shows no way to pay`() {
        mount(invoice(status = "paid"))
        // The screen did load (the paid pill is up), so the panel's absence is real.
        rule.waitUntil(10_000) { rule.onAllNodes(hasText("PAID")).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("Zelle to the business line.").assertDoesNotExist()
        rule.onNodeWithText("How to pay").assertDoesNotExist()
    }
}
