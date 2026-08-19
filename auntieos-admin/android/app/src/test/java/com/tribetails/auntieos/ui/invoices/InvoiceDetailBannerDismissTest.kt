package com.tribetails.auntieos.ui.invoices

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
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
 * #444's Android half of the two banners PR #419 wired to `dismissible` on web
 * (`InvoiceDetail.tsx`, `invoice-detail__dispute` and the "Archived" notice):
 * both are computed straight from the invoice record rather than from local
 * state, so the caller has nothing an `onDismiss` could clear. Proves the
 * close button exists, works, and matches web's split on the dispute panel
 * between the two states (the WON history is dismissible, the OPEN chargeback
 * is not — it is a live constraint on the money, not a notice to file away).
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class InvoiceDetailBannerDismissTest {

    @get:Rule
    val rule = createComposeRule()

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    private fun mount(archivedAt: Any? = null, disputeStatus: String? = null) {
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
            archivedAt = archivedAt,
            disputeStatus = disputeStatus,
            disputeAmountCents = if (disputeStatus != null) 4000L else null,
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

    @Test
    fun `the Archived notice has a close button that dismisses it`() {
        mount(archivedAt = "2026-07-25T00:00:00Z")

        rule.onNodeWithText("Archived").assertIsDisplayed()
        rule.onNodeWithContentDescription("Dismiss").assertIsDisplayed()

        rule.onNodeWithContentDescription("Dismiss").performClick()
        rule.waitForIdle()

        rule.onNodeWithText("Archived").assertDoesNotExist()
    }

    @Test
    fun `a won dispute panel has a close button that dismisses it`() {
        mount(disputeStatus = "won")

        rule.onNodeWithText("Dispute won").assertIsDisplayed()
        rule.onNodeWithContentDescription("Dismiss").assertIsDisplayed()

        rule.onNodeWithContentDescription("Dismiss").performClick()
        rule.waitForIdle()

        rule.onNodeWithText("Dispute won").assertDoesNotExist()
    }

    @Test
    fun `an open chargeback panel gets no close button`() {
        mount(disputeStatus = "needs_response")

        rule.onNodeWithText("This payment is being taken back").assertIsDisplayed()
        rule.onNodeWithContentDescription("Dismiss").assertDoesNotExist()
    }
}
