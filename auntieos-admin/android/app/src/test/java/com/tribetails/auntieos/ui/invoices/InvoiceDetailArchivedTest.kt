package com.tribetails.auntieos.ui.invoices

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.domain.InvoiceAction
import com.tribetails.auntieos.domain.InvoiceState
import com.tribetails.auntieos.domain.invoiceActionsFor
import com.tribetails.auntieos.domain.invoiceActionsOffered
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
 * #2168 review, Android half.
 *
 *  - An archived invoice is read-only until it is restored: the server refuses
 *    to send, edit or link one, so the detail screen offers Restore and none of
 *    Review and send, Edit and Link sessions.
 *  - A restore that could not take every visit back says which in a warning
 *    that stays until dismissed, as web's does. The 4-second toast it used to
 *    be could vanish before the operator read which line to remove.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class InvoiceDetailArchivedTest {

    @get:Rule
    val rule = createComposeRule()

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    private fun draft(archivedAt: Any? = null) = Invoice(
        id = "inv1",
        kinfolkId = "fam1",
        kinfolkName = "Wanda Thorne",
        invoiceNumber = "1029",
        client = "Wanda Thorne",
        date = "2026-07-20",
        total = 45.00,
        amountDue = 45.00,
        status = "draft",
        editScope = "all",
        archivedAt = archivedAt,
    )

    private val invoiceRepo = mockk<InvoiceRepository>(relaxed = true)

    private fun mount(vararg loads: Invoice): InvoiceDetailViewModel {
        val repo = mockk<AuntieRepository>(relaxed = true)
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        coEvery { invoiceRepo.getInvoiceById("inv1") } returnsMany loads.map { Result.success(it) }
        coEvery { kinCareRepo.getKinCareSessionsForKinfolk(any()) } returns Result.success(emptyList())
        coEvery { repo.getBusinessSettings() } returns Result.success(BusinessSettings())
        coEvery { invoiceRepo.getInvoiceLedger("inv1") } returns Result.success(TestFixtures.emptyInvoiceLedger())
        val vm = InvoiceDetailViewModel(repository = repo, invoiceRepository = invoiceRepo, kinCareRepository = kinCareRepo)
        rule.setContent {
            AuntieOSTheme {
                InvoiceDetailScreen(invoiceId = "inv1", onBack = {}, viewModel = vm)
            }
        }
        rule.waitForIdle()
        return vm
    }

    @Test
    fun `an archived draft offers Restore, and no Review and send, Edit or Link sessions`() {
        mount(draft(archivedAt = "2026-07-25T00:00:00Z"))

        rule.onNodeWithText("Restore").assertIsDisplayed()
        rule.onNodeWithText("Review and send").assertDoesNotExist()
        rule.onNodeWithText("Edit").assertDoesNotExist()
        rule.onNodeWithText("Link sessions").assertDoesNotExist()
        rule.onNodeWithContentDescription("Edit linked sessions").assertDoesNotExist()
    }

    @Test
    fun `the same draft, not archived, offers all of them (the control)`() {
        mount(draft())

        rule.onNodeWithText("Archive").assertIsDisplayed()
        rule.onNodeWithText("Review and send").assertIsDisplayed()
        rule.onNodeWithText("Edit").assertIsDisplayed()
        rule.onNodeWithText("Link sessions").assertIsDisplayed()
        rule.onNodeWithContentDescription("Edit linked sessions").assertIsDisplayed()
    }

    @Test
    fun `a restore that could not take a visit back stays on screen until dismissed`() {
        val notice = "1 visit could not be taken back: the visit on 2026-06-02 is now on invoice 1042. " +
            "Its line is still on this draft, so remove it in Edit before sending the draft."
        coEvery { invoiceRepo.unarchiveInvoice("inv1") } returns Result.success(notice)
        val vm = mount(draft(archivedAt = "2026-07-25T00:00:00Z"), draft())

        vm.promptArchive()
        vm.confirmArchive()
        rule.waitForIdle()

        val text = "Invoice restored to the working list. $notice"
        rule.onNodeWithText("Done, but not all of it").assertIsDisplayed()
        rule.onNodeWithText(text).assertIsDisplayed()

        // Well past the toast's 4 seconds: still there.
        rule.mainClock.advanceTimeBy(10_000L)
        rule.waitForIdle()
        rule.onNodeWithText(text).assertIsDisplayed()

        rule.onNodeWithContentDescription("Dismiss").performClick()
        rule.waitForIdle()
        rule.onNodeWithText(text).assertDoesNotExist()
        assertEquals(null, vm.uiState.value.restoreNotice)
    }

    @Test
    fun `a plain restore is still a toast, and leaves no lasting notice`() {
        coEvery { invoiceRepo.unarchiveInvoice("inv1") } returns Result.success("")
        val vm = mount(draft(archivedAt = "2026-07-25T00:00:00Z"), draft())

        vm.promptArchive()
        vm.confirmArchive()
        rule.waitForIdle()

        assertEquals(null, vm.uiState.value.restoreNotice)
        assertEquals("Invoice restored to the working list.", vm.uiState.value.toastMessage)
        rule.onNodeWithText("Done, but not all of it").assertDoesNotExist()
    }
}

/** The pure rule both the list row and the detail screen read. */
class InvoiceActionsOfferedTest {

    @Test
    fun `an archived draft is offered no Review and send`() {
        assertEquals(emptyList<InvoiceAction>(), invoiceActionsOffered(InvoiceState.DRAFT, archived = true))
        assertEquals(listOf(InvoiceAction.REVIEW_AND_SEND), invoiceActionsOffered(InvoiceState.DRAFT, archived = false))
    }

    @Test
    fun `archiving leaves recording a payment as the state gives it and drops Send reminder (#2090)`() {
        (InvoiceState.values().toList() + listOf(null)).forEach { s ->
            assertEquals(
                invoiceActionsFor(s) - InvoiceAction.REVIEW_AND_SEND - InvoiceAction.SEND_REMINDER,
                invoiceActionsOffered(s, archived = true),
            )
        }
    }
}
