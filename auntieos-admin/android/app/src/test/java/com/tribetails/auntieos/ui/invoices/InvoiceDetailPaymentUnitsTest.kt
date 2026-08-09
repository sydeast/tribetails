package com.tribetails.auntieos.ui.invoices

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.captureRoboImage
import com.tribetails.auntieos.data.contracts.GetInvoiceLedgerResult
import com.tribetails.auntieos.data.contracts.GetInvoiceLedgerResultLedgerPayment
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
 * THE 100x DEFECT, AT THE ONE LAYER AN OPERATOR ACTUALLY SEES IT.
 *
 * `stripeWebhook.ts` writes the root `payments` row's `amount` in CENTS when the
 * figure came off the Stripe event and in DOLLARS when it fell back to the local
 * invoice, distinguishable only by `amountSource`. A $137.50 card payment is
 * therefore stored as `amount: 13750`.
 *
 * This screen used to read that collection straight out of Firestore
 * (`InvoiceRepository.getPayments()`) and hand the raw double to a formatter that
 * treats it as dollars, so the staff invoice screen printed **$13,750.00** for a
 * $137.50 payment — live, in production, for months.
 *
 * The fix is not a second copy of the units rule in Kotlin. It is that this
 * screen now asks `getInvoiceLedger`, the same callable the web ledger uses,
 * which resolves the units once server-side (`resolveLedgerAmountCents`) and
 * answers in integer cents. This test pins the rendered string, because the
 * rendered string is what was wrong.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
// NATIVE, same as the visual harness: the default LEGACY mode makes
// captureRoboImage fall back to a semantics dump instead of a rendered picture.
@GraphicsMode(GraphicsMode.Mode.NATIVE)
// TALL viewport on purpose. The payments panel is the fifth item of a
// LazyColumn, so at the shipping 1920dp height it never composes — which is
// exactly why the tracked `visual/android/invoice-detail.png` golden could not
// have caught this bug: it captures the root, and the row was below the fold.
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class InvoiceDetailPaymentUnitsTest {

    @get:Rule
    val rule = createComposeRule()

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    private val invoice = Invoice(
        id = "inv1",
        kinfolkId = "fam1",
        kinfolkName = "Wanda Thorne",
        invoiceNumber = "1029",
        client = "Wanda Thorne",
        date = "2026-07-20",
        // Deliberately NOT 137.50. If the invoice total matched the payment, the
        // assertion below would pass off the Total row and prove nothing about
        // the payment row that carries the defect.
        total = 200.00,
        amountDue = 62.50,
        status = "open",
    )

    private fun ledgerRow(
        paymentId: String = "evt_1",
        amountCents: Long = 13750L,
        tipCents: Long = 0L,
        method: String = "stripe",
        date: String = "2026-07-20",
        amountResolved: Boolean = true,
    ) = GetInvoiceLedgerResultLedgerPayment(
        paymentId = paymentId,
        amountCents = amountCents,
        amountResolved = amountResolved,
        tipCents = tipCents,
        feeCents = 0L,
        tipBasis = "unknown",
        reconciles = tipCents == 0L,
        appliedCents = 0L,
        unappliedCents = 0L,
        proceedsCents = amountCents,
        autoApply = false,
        appliedInvoiceId = "",
        appliedInvoiceNumber = "",
        method = method,
        reference = "",
        date = date,
        notes = "",
        recordedBy = null,
    )
    private fun ledger(
        ledgerPayments: List<GetInvoiceLedgerResultLedgerPayment> = emptyList(),
        unlinked: List<GetInvoiceLedgerResultLedgerPayment> = emptyList(),
    ) = GetInvoiceLedgerResult(
        invoiceId = "inv1",
        payments = emptyList(),
        paidCents = 0L,
        totalCents = 20000L,
        amountDueCents = 6250L,
        ledgerPayments = ledgerPayments,
        unlinkedKinfolkPayments = unlinked,
        unresolvedAmountCount = (ledgerPayments + unlinked).count { !it.amountResolved }.toLong(),
        sessions = emptyList(),
        missingSessionIds = emptyList(),
        orphanSessionIds = emptyList(),
        truncated = false,
    )
    private fun mount(result: Result<GetInvoiceLedgerResult>) {
        val repo = mockk<AuntieRepository>(relaxed = true)
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        val invoiceRepo = mockk<InvoiceRepository>(relaxed = true)
        coEvery { invoiceRepo.getInvoiceById("inv1") } returns Result.success(invoice)
        coEvery { kinCareRepo.getKinCareSessionsForKinfolk(any()) } returns Result.success(emptyList())
        coEvery { repo.getBusinessSettings() } returns Result.success(BusinessSettings())
        coEvery { invoiceRepo.getInvoiceLedger("inv1") } returns result
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
    fun `a stripe-sourced payment renders as its real amount, not 100x it`() {
        // 13750 is what `stripeWebhook.ts` stored for a $137.50 card payment:
        // Stripe's own integer cents, in a field named `amount`. Before this
        // change the screen read that field raw as dollars and printed
        // "$13750.00" — verified by running this test against the old wiring.
        // The server now resolves it and answers in cents.
        mount(Result.success(ledger(ledgerPayments = listOf(ledgerRow(amountCents = 13750L)))))
        rule.onNodeWithText("$137.50").assertExists()
        rule.onNodeWithText("$13750.00").assertDoesNotExist()
    }
    @Test
    fun `the gross tip is inside the amount, not added to it`() {
        // `amount` is documented on BOTH sides as the whole sum collected from
        // the client, the gross tip included. The old row rendered
        // `amount + tip`, counting a $10.00 tip twice on a $137.50 payment and
        // printing $147.50. The web ledger has always rendered `amountCents`
        // alone; this row now agrees with it.
        mount(
            Result.success(
                ledger(ledgerPayments = listOf(ledgerRow(amountCents = 13750L, tipCents = 1000L))),
            ),
        )
        rule.onNodeWithText("$137.50").assertExists()
        rule.onNodeWithText("$147.50").assertDoesNotExist()
    }
    @Test
    fun `the household fallback comes from the callable too, under its warning`() {
        // Same-household money no bill claims. It is offered only when the
        // invoice has no ledger row of its own, and never without the banner
        // that says it is not attributed to this invoice.
        mount(Result.success(ledger(unlinked = listOf(ledgerRow(amountCents = 13750L)))))
        rule.onNodeWithText("NOT INVOICE-LINKED").assertExists()
        rule.onNodeWithText("$137.50").assertExists()
        rule.onNodeWithText("$13750.00").assertDoesNotExist()
    }
    /**
     * THE UNREADABLE ROW, which is a different fact from a payment of nothing.
     *
     * `resolveLedgerAmountCents` answers `{ amountCents: 0, resolved: false }`
     * for a Stripe event the webhook itself gave up on and for an `amount` that
     * is not a usable number. The 0 is the floor `CentsSchema` allows, not a
     * figure, and this row rendered it as a confident "$0.00" in the same green
     * it uses for money that really arrived.
     */
    @Test
    fun `an amount the server could not read does NOT render as $0_00`() {
        mount(
            Result.success(
                ledger(ledgerPayments = listOf(ledgerRow(amountCents = 0L, amountResolved = false))),
            ),
        )
        rule.onNodeWithText("could not be read").assertExists()
        // The row carries method and date and nothing else, so no legitimate
        // zero on this screen can absorb the assertion.
        rule.onNodeWithText("$0.00").assertDoesNotExist()
    }

    @Test
    fun `a real zero still renders as a figure, because that one IS a reading`() {
        // The twin of the case above. Suppressing both would trade one lie for
        // another: a payment genuinely recorded at zero is a fact the operator
        // is entitled to see.
        mount(Result.success(ledger(ledgerPayments = listOf(ledgerRow(amountCents = 0L)))))
        rule.onNodeWithText("$0.00").assertExists()
        rule.onNodeWithText("could not be read").assertDoesNotExist()
    }

    @Test
    fun `the household fallback flags an unreadable amount too, under its own warning`() {
        // "NOT INVOICE-LINKED" says the row is not this invoice's. It says
        // nothing about whether the figure on it was ever readable, and these
        // rows come off the same reader, so they can carry the same defect.
        mount(Result.success(ledger(unlinked = listOf(ledgerRow(amountCents = 0L, amountResolved = false)))))
        rule.onNodeWithText("NOT INVOICE-LINKED").assertExists()
        rule.onNodeWithText("could not be read").assertExists()
        rule.onNodeWithText("$0.00").assertDoesNotExist()
    }

    @Test
    fun `a failed ledger read shows nothing rather than a figure from somewhere else`() {
        // Fail-loud. There is deliberately no fallback to the old raw Firestore
        // read: falling back would restore the 100x defect on exactly the days
        // the callable is unhealthy.
        mount(Result.failure(RuntimeException("getInvoiceLedger failed: unavailable")))
        rule.onNodeWithText("$137.50").assertDoesNotExist()
        rule.onNodeWithText("$13750.00").assertDoesNotExist()
        rule.onNodeWithText("NOT INVOICE-LINKED").assertDoesNotExist()
    }

    /**
     * Step 6 of the task: LOOK AT IT. Writes the payments panel to
     * `app/build/reports/roborazzi/` — the build directory, not the tracked
     * `visual/android/` goldens, because this is an inspection aid for the
     * change and not a new baseline for CI to police.
     */
    @Test
    fun `capture the payments panel for inspection`() {
        mount(
            Result.success(
                ledger(
                    ledgerPayments = listOf(
                        ledgerRow(paymentId = "evt_1", amountCents = 13750L, tipCents = 1000L),
                        ledgerRow(
                            paymentId = "pay_2",
                            amountCents = 6000L,
                            method = "Venmo",
                            date = "2026-07-02",
                        ),
                    ),
                ),
            ),
        )
        rule.onRoot().captureRoboImage("build/reports/roborazzi/invoice-detail-payments.png")
    }
}
