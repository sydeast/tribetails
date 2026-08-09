package com.tribetails.auntieos.ui.invoices

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.onAllNodesWithText
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
import kotlinx.coroutines.CompletableDeferred
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
 * THE FIVE COLUMNS THE OPERATOR READS ON THE WEB, ON THE PHONE SHE ACTUALLY
 * CARRIES.
 *
 * `getInvoiceLedger` has always answered with `tipCents`, `feeCents`,
 * `appliedCents` and `unappliedCents`; Android has always decoded them and held
 * them in state; and the row threw all four away and printed the amount alone.
 * So invoice #1029 (Amount $137.50, Applied $127.50, Tip $10.00, Fee $2.71)
 * read on the phone as one number with nothing to check it against, which is
 * the exact condition that let $2.71 go missing in the first place.
 *
 * These pin the RENDERED STRINGS, because the rendered string is what was
 * missing. Nothing here is a golden: they assert facts, not pixels.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
// TALL viewport, same reason `InvoiceDetailPaymentUnitsTest` gives: the payments
// panel is well down a LazyColumn and never composes at a phone height.
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class InvoiceDetailLedgerColumnsTest {

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
        // Deliberately unlike every figure asserted below, so no assertion can
        // pass off the Amounts panel instead of the ledger row.
        total = 300.00,
        amountDue = 44.44,
        status = "open",
    )

    /** Invoice #1029 as it is actually stored, once the fee was recorded. */
    private fun row(
        paymentId: String = "pay_1029",
        amountCents: Long = 13750L,
        amountResolved: Boolean = true,
        tipCents: Long = 1000L,
        feeCents: Long = 271L,
        tipBasis: String = "gross",
        reconciles: Boolean = true,
        appliedCents: Long = 12750L,
        unappliedCents: Long = 0L,
        autoApply: Boolean = false,
        appliedInvoiceId: String = "inv1",
        appliedInvoiceNumber: String = "1029",
        method: String = "Venmo",
    ) = GetInvoiceLedgerResultLedgerPayment(
        paymentId = paymentId,
        amountCents = amountCents,
        amountResolved = amountResolved,
        tipCents = tipCents,
        feeCents = feeCents,
        tipBasis = tipBasis,
        reconciles = reconciles,
        appliedCents = appliedCents,
        unappliedCents = unappliedCents,
        proceedsCents = amountCents - feeCents,
        autoApply = autoApply,
        appliedInvoiceId = appliedInvoiceId,
        appliedInvoiceNumber = appliedInvoiceNumber,
        method = method,
        reference = "",
        date = "2026-07-20",
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
        totalCents = 30000L,
        amountDueCents = 4444L,
        ledgerPayments = ledgerPayments,
        unlinkedKinfolkPayments = unlinked,
        unresolvedAmountCount = (ledgerPayments + unlinked).count { !it.amountResolved }.toLong(),
        sessions = emptyList(),
        missingSessionIds = emptyList(),
        orphanSessionIds = emptyList(),
        truncated = false,
    )

    private fun mount(result: Result<GetInvoiceLedgerResult>) {
        rule.setContent {
            AuntieOSTheme {
                InvoiceDetailScreen(invoiceId = "inv1", onBack = {}, viewModel = viewModelFor(result))
            }
        }
        rule.waitForIdle()
    }

    private fun viewModelFor(result: Result<GetInvoiceLedgerResult>): InvoiceDetailViewModel {
        val repo = mockk<AuntieRepository>(relaxed = true)
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        val invoiceRepo = mockk<InvoiceRepository>(relaxed = true)
        coEvery { invoiceRepo.getInvoiceById("inv1") } returns Result.success(invoice)
        coEvery { kinCareRepo.getKinCareSessionsForKinfolk(any()) } returns Result.success(emptyList())
        coEvery { repo.getBusinessSettings() } returns Result.success(BusinessSettings())
        coEvery { invoiceRepo.getInvoiceLedger("inv1") } returns result
        return InvoiceDetailViewModel(
            repository = repo,
            invoiceRepository = invoiceRepo,
            kinCareRepository = kinCareRepo,
        )
    }

    // ── The five columns ──────────────────────────────────────────────────────

    @Test
    fun `invoice 1029 reads across the row and adds up`() {
        // amount(137.50) = applied(127.50) + tipGross(10.00) + balance(0.00).
        // Every one of those four was on the wire and none of the last three
        // reached the screen.
        mount(Result.success(ledger(ledgerPayments = listOf(row()))))
        rule.onNodeWithText("$137.50").assertExists()
        rule.onNodeWithText("#1029").assertExists()
        rule.onNodeWithText("$127.50").assertExists()
        rule.onNodeWithText("$10.00").assertExists()
        rule.onNodeWithText("$2.71").assertExists()
        // Labelled, so a column of figures is not four unexplained numbers.
        rule.onNodeWithText("APPLIED TO").assertExists()
        rule.onNodeWithText("TIP").assertExists()
        rule.onNodeWithText("FEE").assertExists()
        rule.onNodeWithText("BALANCE").assertExists()
    }

    @Test
    fun `a gross tip says so, because that is the half that matters at tax time`() {
        mount(Result.success(ledger(ledgerPayments = listOf(row()))))
        rule.onNodeWithText("gross").assertExists()
    }

    @Test
    fun `an unrecorded fee is not a zero`() {
        // The migrated shape: a net tip whose fee was thrown away. "$0.00"
        // here would be the claim that made #1029 unreadable.
        mount(
            Result.success(
                ledger(
                    ledgerPayments = listOf(
                        row(tipCents = 729L, feeCents = 0L, tipBasis = "unknown", reconciles = false),
                    ),
                ),
            ),
        )
        rule.onNodeWithText("not recorded").assertExists()
        rule.onNodeWithText("without its processor fee", substring = true).assertExists()
    }

    @Test
    fun `a fee that really was zero still prints as zero`() {
        // A reading, not an absence. Suppressing it would trade one lie for
        // another.
        // Applied and tip deliberately leave a non-zero balance, so the one
        // "$0.00" on screen can only be the Fee.
        mount(
            Result.success(
                ledger(
                    ledgerPayments = listOf(
                        row(feeCents = 0L, reconciles = true, appliedCents = 12250L, unappliedCents = 500L),
                    ),
                ),
            ),
        )
        rule.onNodeWithText("$0.00").assertExists()
        rule.onNodeWithText("not recorded").assertDoesNotExist()
    }

    @Test
    fun `an over-applied row shows its negative balance rather than a comfortable zero`() {
        mount(
            Result.success(
                ledger(
                    ledgerPayments = listOf(
                        row(appliedCents = 14750L, unappliedCents = -2000L),
                    ),
                ),
            ),
        )
        rule.onNodeWithText("-$20.00").assertExists()
        rule.onNodeWithText("does not balance", substring = true).assertExists()
    }

    @Test
    fun `a leftover held as account credit says where it went`() {
        mount(
            Result.success(
                ledger(
                    ledgerPayments = listOf(
                        row(appliedCents = 10000L, unappliedCents = 2750L, autoApply = true),
                    ),
                ),
            ),
        )
        rule.onNodeWithText("$27.50").assertExists()
        rule.onNodeWithText("held as credit").assertExists()
    }

    @Test
    fun `a payment that touched no balance says so instead of applying zero`() {
        mount(
            Result.success(
                ledger(
                    ledgerPayments = listOf(
                        row(
                            appliedInvoiceId = "",
                            appliedInvoiceNumber = "",
                            appliedCents = 0L,
                            unappliedCents = 12750L,
                        ),
                    ),
                ),
            ),
        )
        rule.onNodeWithText("not applied").assertExists()
    }

    // ── The unreadable amount ─────────────────────────────────────────────────

    @Test
    fun `a row whose amount could not be read shows no figure and no balance derived from it`() {
        // `amountCents` is 0 on such a row because 0 is the floor the schema
        // allows. The balance the server computed from it (0 - applied - tip)
        // is arithmetic on that non-reading, so it gets the same treatment as
        // the amount rather than a confident minus sign.
        mount(
            Result.success(
                ledger(
                    ledgerPayments = listOf(
                        row(
                            amountCents = 0L,
                            amountResolved = false,
                            tipCents = 0L,
                            feeCents = 0L,
                            appliedCents = 12750L,
                            unappliedCents = -12750L,
                        ),
                    ),
                ),
            ),
        )
        // TWICE: once where the amount goes, once where the balance does. The
        // tip and fee below them are genuine zeros read from their own fields
        // and still print as $0.00, which is why this counts the stand-ins
        // rather than banning every zero on screen.
        rule.onAllNodesWithText("could not be read").assertCountEquals(2)
        rule.onNodeWithText("-$127.50").assertDoesNotExist()
        // The applied figure IS a reading of its own field, so it still shows.
        rule.onNodeWithText("$127.50").assertExists()
    }

    // ── The two lists get the same treatment ──────────────────────────────────

    @Test
    fun `the not-invoice-linked list carries the same columns and the same caveats`() {
        // Android shows a household fallback the web ledger has no equivalent
        // for. It is the same shape of record, so it gets the same reading,
        // and the caveat cannot be keyed to the linked list alone.
        mount(
            Result.success(
                ledger(
                    unlinked = listOf(
                        row(tipCents = 729L, feeCents = 0L, tipBasis = "unknown", reconciles = false),
                    ),
                ),
            ),
        )
        rule.onNodeWithText("NOT INVOICE-LINKED").assertExists()
        rule.onNodeWithText("FEE").assertExists()
        rule.onNodeWithText("not recorded").assertExists()
        rule.onNodeWithText("without its processor fee", substring = true).assertExists()
    }

    // ── Nothing here vs nothing read ──────────────────────────────────────────

    @Test
    fun `a failed ledger read does not read as an invoice with no payments`() {
        // The toast is transient; the panel is not. Left alone, the empty hint
        // below states as a fact about the invoice what is really a fact about
        // the network.
        mount(Result.failure(RuntimeException("getInvoiceLedger failed: unavailable")))
        rule.onNodeWithText("No payment recorded against this invoice", substring = true)
            .assertDoesNotExist()
        // The panel says it, and says it verbatim. The transient toast carries
        // the same words, hence the count rather than a single node.
        rule.onAllNodesWithText("getInvoiceLedger failed: unavailable", substring = true)
            .assertCountEquals(2)
        // And it says which kind of nothing this is.
        rule.onNodeWithText("because the read failed", substring = true).assertExists()
        rule.onNodeWithText("Try again").assertExists()
    }

    @Test
    fun `a ledger still loading does not claim the invoice has no payments`() {
        val pending = CompletableDeferred<Result<GetInvoiceLedgerResult>>()
        val repo = mockk<AuntieRepository>(relaxed = true)
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        val invoiceRepo = mockk<InvoiceRepository>(relaxed = true)
        coEvery { invoiceRepo.getInvoiceById("inv1") } returns Result.success(invoice)
        coEvery { kinCareRepo.getKinCareSessionsForKinfolk(any()) } returns Result.success(emptyList())
        coEvery { repo.getBusinessSettings() } returns Result.success(BusinessSettings())
        coEvery { invoiceRepo.getInvoiceLedger("inv1") } coAnswers { pending.await() }
        val vm = InvoiceDetailViewModel(
            repository = repo,
            invoiceRepository = invoiceRepo,
            kinCareRepository = kinCareRepo,
        )
        rule.setContent {
            AuntieOSTheme { InvoiceDetailScreen(invoiceId = "inv1", onBack = {}, viewModel = vm) }
        }
        rule.waitForIdle()
        rule.onNodeWithText("No payment recorded against this invoice", substring = true)
            .assertDoesNotExist()
        pending.complete(Result.success(ledger()))
    }

    /**
     * LOOK AT IT. Writes the panel to `app/build/reports/roborazzi/`: the build
     * directory, not the tracked `visual/android/` goldens: an inspection aid
     * for this change, not a new baseline for CI to police.
     */
    @Test
    fun `capture the ledger columns for inspection`() {
        mount(
            Result.success(
                ledger(
                    ledgerPayments = listOf(
                        row(),
                        row(
                            paymentId = "pay_legacy",
                            amountCents = 6000L,
                            tipCents = 729L,
                            feeCents = 0L,
                            tipBasis = "unknown",
                            reconciles = false,
                            appliedCents = 5271L,
                            unappliedCents = 0L,
                            method = "PayPal",
                        ),
                    ),
                ),
            ),
        )
        rule.onRoot().captureRoboImage("build/reports/roborazzi/invoice-detail-ledger-columns.png")
    }
}
