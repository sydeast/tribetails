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
        disputeEvidenceDueByMs: Long? = null,
        disputeReason: String? = null,
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
            disputeEvidenceDueByMs = disputeEvidenceDueByMs,
            disputeReason = disputeReason,
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

    // ---- THE DEADLINE AND THE REASON --------------------------------------
    //
    // A chargeback nobody answers in time is lost by default, so the date is the
    // time-critical half of this panel. Deadlines here are expressed relative to
    // the real clock rather than pinned: the composable reads the clock once,
    // and the branch arithmetic itself is pinned in InvoiceDisputeDeadlineTest
    // where `nowMs` is a parameter.

    @Test
    fun `an answerable chargeback counts down to its deadline`() {
        // Comfortably inside the third day, so the case cannot straddle a
        // boundary however long the suite takes to reach it.
        val dueBy = System.currentTimeMillis() + 3 * 86_400_000L + 3_600_000L
        mount(disputeStatus = "needs_response", disputeId = "dp_1", disputeEvidenceDueByMs = dueBy)
        rule.onNodeWithText(alarmTitle).assertIsDisplayed()
        rule.onNode(hasText("3 days left", substring = true)).assertExists()
        // MILLISECONDS, NOT SECONDS. Dividing by 1000 would date this to 1970,
        // and the year is the cheapest possible proof it did not happen.
        //
        // Scoped to the deadline sentence itself: the invoice date card on this
        // same screen also carries a 2026, and a bare year match would pass off
        // that card while proving nothing about the countdown.
        val year = java.time.Instant.ofEpochMilli(dueBy)
            .atZone(java.time.ZoneId.systemDefault()).year.toString()
        rule.onNode(hasText("Respond by", substring = true) and hasText(year, substring = true))
            .assertExists()
        rule.onNode(hasText("1970", substring = true)).assertDoesNotExist()
    }

    /**
     * NULL IS NEITHER ZERO NOR AN ERROR. Stripe sends `due_by: 0` on purpose,
     * meaning the issuing bank allows no response at all, and the webhook maps
     * that and a genuinely absent value both to null. The banner still renders,
     * the countdown is suppressed, and the operator is sent to Stripe.
     */
    @Test
    fun `a needed response with no stated deadline says so and sends them to Stripe`() {
        mount(disputeStatus = "needs_response", disputeId = "dp_1")
        rule.onNodeWithText(alarmTitle).assertIsDisplayed()
        rule.onNode(hasText("no response deadline", substring = true)).assertExists()
        rule.onNode(hasText("Stripe dashboard", substring = true)).assertExists()
        rule.onNode(hasText("left", substring = true)).assertDoesNotExist()
        rule.onNode(hasText("1970", substring = true)).assertDoesNotExist()
    }

    /** A stored 0 is the same statement as an absent one, and never a date. */
    @Test
    fun `a stored deadline of zero reads as no deadline, not as the epoch`() {
        mount(disputeStatus = "needs_response", disputeEvidenceDueByMs = 0L)
        rule.onNode(hasText("no response deadline", substring = true)).assertExists()
        rule.onNode(hasText("1970", substring = true)).assertDoesNotExist()
    }

    /**
     * A DEADLINE THAT HAS PASSED IS ITS OWN STATE. `disputeStatus` is a webhook
     * mirror of Stripe's, so it can still read `needs_response` after the
     * window shut. The panel says the window closed, admits its own reading can
     * lag, and sends the operator to Stripe — it does not declare the dispute
     * lost, and it prints no negative countdown.
     */
    @Test
    fun `a passed deadline says the window closed without calling the dispute lost`() {
        mount(
            disputeStatus = "needs_response",
            disputeId = "dp_1",
            disputeEvidenceDueByMs = System.currentTimeMillis() - 2 * 86_400_000L,
        )
        rule.onNodeWithText(alarmTitle).assertIsDisplayed()
        rule.onNode(hasText("window to respond closed", substring = true)).assertExists()
        rule.onNode(hasText("Stripe dashboard", substring = true)).assertExists()
        rule.onNode(hasText("left", substring = true)).assertDoesNotExist()
        rule.onNode(hasText("is lost", substring = true)).assertDoesNotExist()
    }

    /**
     * THE ONE THE OPERATOR ASKED FOR, EXTENDED TO THE CLOCK. Nothing ever
     * clears any of these fields, so a won dispute keeps its deadline forever.
     * Counting down to it would send the operator to fight a settled contest.
     */
    @Test
    fun `a won dispute shows no countdown, deadline on the document or not`() {
        mount(
            disputeStatus = "won",
            disputeId = "dp_1",
            disputeEvidenceDueByMs = System.currentTimeMillis() + 5 * 86_400_000L,
            disputeReason = "fraudulent",
        )
        rule.onNodeWithText(historyTitle).assertIsDisplayed()
        rule.onNodeWithText(alarmTitle).assertDoesNotExist()
        rule.onNode(hasText("Respond by", substring = true)).assertDoesNotExist()
        rule.onNode(hasText("left", substring = true)).assertDoesNotExist()
        rule.onNode(hasText("deadline", substring = true)).assertDoesNotExist()
    }

    /**
     * `lost` keeps the alarm per the #309 rule — where contested money ends up
     * is the operator's call — but there is nothing left to answer, so no clock.
     */
    @Test
    fun `a lost dispute keeps the alarm and gets no countdown`() {
        mount(
            disputeStatus = "lost",
            disputeEvidenceDueByMs = System.currentTimeMillis() + 5 * 86_400_000L,
        )
        rule.onNodeWithText(alarmTitle).assertIsDisplayed()
        rule.onNode(hasText("Respond by", substring = true)).assertDoesNotExist()
        rule.onNode(hasText("left", substring = true)).assertDoesNotExist()
    }

    @Test
    fun `a known reason shows the raw Stripe token and plain English beside it`() {
        mount(disputeStatus = "needs_response", disputeReason = "product_not_received")
        rule.onNode(hasText("product_not_received", substring = true)).assertExists()
        rule.onNode(hasText("never delivered", substring = true)).assertExists()
    }

    /**
     * FALL THROUGH TO THE RAW TOKEN. `reason` is a plain `String` in the pinned
     * SDK and Stripe adds categories without asking. One this build has never
     * seen is shown as sent: not relabelled, not "Unknown", and it does not
     * take the banner down with it.
     */
    @Test
    fun `a reason it has never seen shows as the raw token, never as Unknown`() {
        mount(disputeStatus = "needs_response", disputeReason = "a_category_from_2027")
        rule.onNodeWithText(alarmTitle).assertIsDisplayed()
        rule.onNode(hasText("a_category_from_2027", substring = true)).assertExists()
        rule.onNode(hasText("Unknown", substring = true, ignoreCase = true)).assertDoesNotExist()
    }

    /** The reason is history worth keeping on a settled dispute; the clock is not. */
    @Test
    fun `a won dispute keeps its reason while keeping the countdown off`() {
        mount(disputeStatus = "won", disputeReason = "duplicate")
        rule.onNodeWithText(historyTitle).assertIsDisplayed()
        rule.onNode(hasText("duplicate", substring = true)).assertExists()
        rule.onNode(hasText("Respond by", substring = true)).assertDoesNotExist()
    }
}
