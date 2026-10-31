package com.tribetails.auntieos.ui.invoices

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.TestFixtures
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
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * #1174 on screen: Edit is offered per the stored editScope, and under
 * `metadataOnly` the money is shown read-only rather than hidden.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class InvoiceEditScreenTest {

    @get:Rule
    val rule = createComposeRule()

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    private fun mount(scope: String) {
        val invoice = Invoice(
            id = "inv1",
            kinfolkId = "fam1",
            invoiceNumber = "1042",
            client = "Wanda Thorne",
            date = "2026-10-01",
            dueDate = "2999-12-31",
            total = 25.0,
            amountDue = 25.0,
            status = "open",
            editScope = scope,
            lineItems = listOf(mapOf("description" to "Overnight stay", "qty" to 1, "unitCents" to 2500)),
        )
        val repo = mockk<AuntieRepository>(relaxed = true)
        val kinCareRepo = mockk<KinCareRepository>(relaxed = true)
        val invoiceRepo = mockk<InvoiceRepository>(relaxed = true)
        coEvery { invoiceRepo.getInvoiceById("inv1") } returns Result.success(invoice)
        coEvery { invoiceRepo.getInvoiceLedger("inv1") } returns Result.success(TestFixtures.emptyInvoiceLedger())
        coEvery { kinCareRepo.getKinCareSessionsForKinfolk(any()) } returns Result.success(emptyList())
        coEvery { repo.getBusinessSettings() } returns Result.success(BusinessSettings())
        val vm = InvoiceDetailViewModel(repository = repo, invoiceRepository = invoiceRepo, kinCareRepository = kinCareRepo)
        rule.setContent {
            AuntieOSTheme { InvoiceDetailScreen(invoiceId = "inv1", onBack = {}, viewModel = vm) }
        }
        rule.waitForIdle()
    }

    @Test
    fun `scope none offers no Edit`() {
        mount("none")
        assertEquals(0, rule.onAllNodesWithText("Edit").fetchSemanticsNodes().size)
    }

    @Test
    fun `scope all opens an editable line`() {
        mount("all")
        rule.onNodeWithText("Edit").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Edit invoice").assertIsDisplayed()
        rule.onNodeWithText("LINE 1 DESCRIPTION").assertIsDisplayed()
        rule.onNodeWithText("Add line").assertIsDisplayed()
        assertEquals(0, rule.onAllNodesWithText("Money is locked").fetchSemanticsNodes().size)
    }

    @Test
    fun `scope metadataOnly shows the money read-only, not hidden`() {
        mount("metadataOnly")
        rule.onNodeWithText("Edit").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Money is locked").assertIsDisplayed()
        rule.onNodeWithText("INVOICE NUMBER").assertIsDisplayed()
        // The line is on screen as text inside the dialog, with no field to type into.
        assertEquals(2, rule.onAllNodesWithText("Overnight stay").fetchSemanticsNodes().size)
        assertEquals(0, rule.onAllNodesWithText("LINE 1 DESCRIPTION").fetchSemanticsNodes().size)
        assertEquals(0, rule.onAllNodesWithText("Add line").fetchSemanticsNodes().size)
    }
}
