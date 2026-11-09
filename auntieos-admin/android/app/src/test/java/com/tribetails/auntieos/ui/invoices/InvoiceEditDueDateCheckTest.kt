package com.tribetails.auntieos.ui.invoices

import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.domain.InvoiceTermsCode
import com.tribetails.auntieos.ui.admin.DUE_BEFORE_INVOICE_DATE
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * #1593 on the Android invoice editor: a typed due date before the invoice
 * date is refused under the due date field with Save disabled, and a discount
 * larger than the subtotal shows no total rather than a negative one.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class InvoiceEditDueDateCheckTest {

    @get:Rule
    val rule = createComposeRule()

    private fun invoice(termsCode: String = "") = Invoice(
        id = "inv1",
        kinfolkId = "fam1",
        invoiceNumber = "1042",
        date = "2026-11-05",
        dueDate = "2026-11-19",
        total = 25.0,
        amountDue = 25.0,
        status = "open",
        editScope = "all",
        termsCode = termsCode,
        lineItems = listOf(mapOf("description" to "Dog walk", "qty" to 1, "unitCents" to 2500)),
    )

    private fun draft(invoice: Invoice = invoice()) = invoiceEditDraftOf(invoice)!!

    // ── the due date, pure ────────────────────────────────────────────────────

    @Test
    fun `an untouched invoice is not judged, even one already in the wrong order`() {
        val old = invoice().apply { dueDate = "2026-11-01" }
        assertNull(invoiceEditDueOrderProblem(draft(old)))
        // A metadata edit on it still saves.
        val outcome = invoiceEditPatchOf(old, draft(old).copy(address = "12 Elm Row"))
        assertNull(outcome.error)
    }

    @Test
    fun `a due date moved before the invoice date is refused, in the draft and in the patch`() {
        val edited = draft().copy(dueDate = "2026-11-01")
        assertEquals(DUE_BEFORE_INVOICE_DATE, invoiceEditDueOrderProblem(edited))
        val outcome = invoiceEditPatchOf(invoice(), edited)
        assertNull(outcome.patch)
        assertEquals(DUE_BEFORE_INVOICE_DATE, outcome.error)
    }

    @Test
    fun `an invoice date moved past the due date is refused the same way`() {
        assertEquals(DUE_BEFORE_INVOICE_DATE, invoiceEditDueOrderProblem(draft().copy(date = "2026-11-20")))
    }

    @Test
    fun `a due date on or after the invoice date saves`() {
        val edited = draft().copy(dueDate = "2026-11-05")
        assertNull(invoiceEditDueOrderProblem(edited))
        val outcome = invoiceEditPatchOf(invoice(), edited)
        assertNull(outcome.error)
        assertEquals("2026-11-05", outcome.patch?.dueDate)
    }

    @Test
    fun `newly picked structured terms set the due date themselves and are not judged`() {
        val edited = draft().copy(dueDate = "2026-11-01", termsCode = InvoiceTermsCode.NET_30)
        assertNull(invoiceEditDueOrderProblem(edited))
        assertNull(invoiceEditPatchOf(invoice(), edited).error)
    }

    @Test
    fun `a stored structured code leaves the due date to the server`() {
        val stored = invoice(termsCode = "net_14")
        assertNull(invoiceEditDueOrderProblem(draft(stored).copy(dueDate = "2026-11-01")))
    }

    @Test
    fun `switching to custom terms judges the typed due date`() {
        val stored = invoice(termsCode = "net_14")
        val edited = draft(stored).copy(dueDate = "2026-11-01", termsCode = InvoiceTermsCode.CUSTOM)
        assertEquals(DUE_BEFORE_INVOICE_DATE, invoiceEditDueOrderProblem(edited))
    }

    // ── the preview, pure ─────────────────────────────────────────────────────

    @Test
    fun `a discount larger than the subtotal has no total, and says why beside the discount`() {
        val preview = invoiceEditPreviewOf(listOf(InvoiceEditLine("Dog walk", "1", "25")), "77")
        assertFalse(preview.hasTotal)
        assertEquals("Invoice discount (\$77.00) is larger than the subtotal (\$25.00).", preview.discountProblem)
    }

    @Test
    fun `letters in the discount have no total either`() {
        val preview = invoiceEditPreviewOf(listOf(InvoiceEditLine("Dog walk", "1", "25")), "ten")
        assertFalse(preview.hasTotal)
        assertEquals("Invoice discount needs a dollar amount, or leave it empty.", preview.discountProblem)
    }

    @Test
    fun `a line discount larger than its line is refused on that line`() {
        val preview = invoiceEditPreviewOf(
            listOf(InvoiceEditLine("Dog walk", "1", "25", "30"), InvoiceEditLine("Bath", "1", "10")),
            "",
        )
        assertFalse(preview.hasTotal)
        assertEquals(
            listOf("Discount for \"Dog walk\" (\$30.00) is larger than the line itself (\$25.00).", null),
            preview.lineProblems,
        )
        assertNull(preview.discountProblem)
    }

    @Test
    fun `a sound discount shows the real total`() {
        val preview = invoiceEditPreviewOf(listOf(InvoiceEditLine("Dog walk", "1", "25")), "5")
        assertTrue(preview.hasTotal)
        assertEquals(2000L, preview.totalCents)
    }

    // ── on screen ─────────────────────────────────────────────────────────────

    private fun mount(draft: InvoiceEditDraft) {
        rule.setContent {
            AuntieOSTheme {
                InvoiceEditDialog(
                    draft = draft,
                    error = null,
                    saving = false,
                    onChange = {},
                    onSave = {},
                    onDismiss = {},
                    onOpenVisit = {},
                )
            }
        }
        rule.waitForIdle()
    }

    @Test
    fun `the refusal sits under the due date and Save is disabled`() {
        mount(draft().copy(dueDate = "2026-11-01"))
        rule.onNodeWithText(DUE_BEFORE_INVOICE_DATE, useUnmergedTree = true).assertExists()
        rule.onNodeWithText("Save changes").assertIsNotEnabled()
    }

    @Test
    fun `a good due date leaves Save enabled and says nothing`() {
        mount(draft().copy(dueDate = "2026-11-12"))
        assertEquals(0, rule.onAllNodesWithText(DUE_BEFORE_INVOICE_DATE, useUnmergedTree = true).fetchSemanticsNodes().size)
        rule.onNodeWithText("Save changes").assertIsEnabled()
    }

    @Test
    fun `a too-large discount prints no negative total`() {
        mount(draft().copy(invoiceDiscountText = "77"))
        rule.onNodeWithText("Invoice discount (\$77.00) is larger than the subtotal (\$25.00).", useUnmergedTree = true)
            .assertExists()
        rule.onNodeWithText("Total -", useUnmergedTree = true).assertExists()
        assertEquals(0, rule.onAllNodesWithText("Total -\$52.00", useUnmergedTree = true).fetchSemanticsNodes().size)
    }
}
