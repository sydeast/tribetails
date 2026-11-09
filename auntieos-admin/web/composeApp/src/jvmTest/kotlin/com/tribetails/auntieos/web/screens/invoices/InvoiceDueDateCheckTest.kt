package com.tribetails.auntieos.web.screens.invoices

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.JvmFirestoreRest
import com.tribetails.auntieos.web.data.UninvoicedSession
import com.tribetails.auntieos.web.data.UninvoicedSessionsResult
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1593 on the desktop console: a typed due date before the invoice date, the
 * blank path's typed total, and a discount larger than the subtotal. Each is
 * refused under its field while it is wrong, Create or Save is held back, and
 * no negative total is printed. The sentences are the server's and the other
 * two clients', word for word.
 */
@OptIn(ExperimentalTestApi::class)
class InvoiceDueDateCheckTest {

    // ── the rule itself, pure ─────────────────────────────────────────────────

    @Test
    fun theSentencesMatchTheServerAndTheOtherClients() {
        assertEquals("The due date has to be on or after the invoice date.", DUE_BEFORE_INVOICE_DATE)
        assertEquals("Enter the total as dollars, zero or more, like 120.00.", BLANK_TOTAL_PROBLEM)
    }

    @Test
    fun aDueDateOnOrAfterTheInvoiceDatePasses() {
        assertNull(dueDateOrderProblem("2026-11-05", "2026-11-05", "custom"))
        assertNull(dueDateOrderProblem("2026-11-05", "2026-12-01", null))
    }

    @Test
    fun aTypedDueDateBeforeTheInvoiceDateIsRefused() {
        assertEquals(DUE_BEFORE_INVOICE_DATE, dueDateOrderProblem("2026-11-05", "2026-11-04", "custom"))
        assertEquals(DUE_BEFORE_INVOICE_DATE, dueDateOrderProblem("2026-11-05", "2026-11-04", null))
        assertEquals(DUE_BEFORE_INVOICE_DATE, dueDateOrderProblem("2026-11-05", "2026-11-04", ""))
    }

    @Test
    fun structuredTermsABlankAndAFreeTextDateAreNotJudged() {
        assertNull(dueDateOrderProblem("2026-11-05", "2026-11-04", "net_14"))
        assertNull(dueDateOrderProblem("2026-11-05", "", "custom"))
        assertNull(dueDateOrderProblem("", "2026-11-04", "custom"))
        assertNull(dueDateOrderProblem("2026-11-05", "Nov 4", "custom"))
    }

    private val walk = UninvoicedSession("s1", "kf1", "Dog walk", 30.0, "2026-11-01T15:00:00.000Z", 2500L)

    private fun blocked(
        path: InvoiceCreatePath = InvoiceCreatePath.WORK,
        termsCode: InvoiceTermsCode = InvoiceTermsCode.CUSTOM,
        customDueDate: String = "",
        totalText: String = "",
    ): String? {
        val date = "2026-11-05"
        val due = resolveDueDate(termsCode, date, listOf(walk.startTime), date)
        val money = composerMoney(listOf(walk), setOf("s1"), emptyMap(), emptyList(), "")
        return composerBlockedReason("kf1", path, termsCode, due, date, customDueDate, 1, 0, money, totalText)
    }

    @Test
    fun aCustomDueDateBeforeTheInvoiceDateHoldsCreateBackOnBothPaths() {
        assertEquals(DUE_BEFORE_INVOICE_DATE, blocked(customDueDate = "2026-11-04"))
        assertEquals(
            DUE_BEFORE_INVOICE_DATE,
            blocked(path = InvoiceCreatePath.BLANK, customDueDate = "2026-11-01", totalText = "40"),
        )
        assertNull(blocked(customDueDate = "2026-11-05"))
        // A stale custom date is not judged once structured terms are picked.
        assertNull(blocked(termsCode = InvoiceTermsCode.DUE_ON_RECEIPT, customDueDate = "2026-01-01"))
    }

    @Test
    fun theBlankTotalIsRefusedWithTheSharedSentence() {
        for (bad in listOf("abc", "-5", "", "12.345")) {
            assertEquals(BLANK_TOTAL_PROBLEM, blankTotalProblem(bad), bad)
        }
        assertNull(blankTotalProblem("120.00"))
        assertNull(blankTotalProblem("0"))
    }

    @Test
    fun aMoneyRefusalIsPlacedUnderTheFieldThatCausedIt() {
        val tooBig = composerMoney(listOf(walk), setOf("s1"), emptyMap(), emptyList(), "77")
        assertEquals("Invoice discount (\$77.00) is larger than the subtotal (\$25.00).", tooBig.error)
        assertEquals(tooBig.error, invoiceDiscountProblemOf(tooBig.error))

        val line = composerMoney(emptyList(), emptySet(), emptyMap(), listOf(ComposerDraftLine("Mileage", "1", "25", "30")), "")
        assertEquals(line.error, lineDiscountProblemOf(line.error, "Mileage"))
        assertNull(lineDiscountProblemOf(line.error, "Bath"))
        assertNull(invoiceDiscountProblemOf(line.error))

        val sound = composerMoney(listOf(walk), setOf("s1"), emptyMap(), emptyList(), "5")
        assertNull(sound.error)
        assertEquals(2000L, sound.totalCents)
    }

    // ── the editor, pure ──────────────────────────────────────────────────────

    private fun invoice(termsCode: String = "", dueDate: String = "2026-11-19"): Invoice =
        JvmFirestoreRest.codec.decodeFromString(
            Invoice.serializer(),
            """
            {"_id":"inv1","kinfolkId":"fam1","invoiceNumber":"1042","date":"2026-11-05","dueDate":"$dueDate",
             "termsCode":"$termsCode","total":25.0,"amountDue":25.0,"status":"open","editScope":"all",
             "lineItems":[{"description":"Dog walk","qty":1,"unitCents":2500}],"invoiceDiscountCents":0}
            """.trimIndent(),
        )

    private fun draft(invoice: Invoice = invoice()) = invoiceEditDraftOf(invoice)!!

    @Test
    fun anUntouchedInvoiceIsNotJudgedEvenInTheWrongOrder() {
        val old = invoice(dueDate = "2026-11-01")
        assertNull(invoiceEditDueOrderProblem(draft(old)))
        assertNull(invoiceEditPatchOf(old, draft(old).copy(address = "12 Elm Row")).error)
    }

    @Test
    fun aDueDateMovedBeforeTheInvoiceDateIsRefusedInTheDraftAndThePatch() {
        val edited = draft().copy(dueDate = "2026-11-01")
        assertEquals(DUE_BEFORE_INVOICE_DATE, invoiceEditDueOrderProblem(edited))
        val outcome = invoiceEditPatchOf(invoice(), edited)
        assertNull(outcome.patch)
        assertEquals(DUE_BEFORE_INVOICE_DATE, outcome.error)
        assertEquals(DUE_BEFORE_INVOICE_DATE, invoiceEditDueOrderProblem(draft().copy(date = "2026-11-20")))
    }

    @Test
    fun aDueDateOnOrAfterTheInvoiceDateSaves() {
        val outcome = invoiceEditPatchOf(invoice(), draft().copy(dueDate = "2026-11-05"))
        assertNull(outcome.error)
        assertEquals("\"2026-11-05\"", outcome.patch!!["dueDate"].toString())
    }

    @Test
    fun structuredTermsLeaveTheDueDateToTheServer() {
        assertNull(invoiceEditDueOrderProblem(draft().copy(dueDate = "2026-11-01", termsCode = InvoiceTermsCode.NET_30)))
        assertNull(invoiceEditDueOrderProblem(draft(invoice(termsCode = "net_14")).copy(dueDate = "2026-11-01")))
        assertEquals(
            DUE_BEFORE_INVOICE_DATE,
            invoiceEditDueOrderProblem(
                draft(invoice(termsCode = "net_14")).copy(dueDate = "2026-11-01", termsCode = InvoiceTermsCode.CUSTOM),
            ),
        )
    }

    @Test
    fun theEditPreviewHasNoTotalWhileTheMoneyIsRefused() {
        val tooBig = invoiceEditPreviewOf(listOf(InvoiceEditLine("Dog walk", "1", "25")), "77")
        assertFalse(tooBig.hasTotal)
        assertEquals("Invoice discount (\$77.00) is larger than the subtotal (\$25.00).", tooBig.discountProblem)

        val letters = invoiceEditPreviewOf(listOf(InvoiceEditLine("Dog walk", "1", "25")), "ten")
        assertEquals("Invoice discount needs a dollar amount, or leave it empty.", letters.discountProblem)

        val line = invoiceEditPreviewOf(listOf(InvoiceEditLine("Dog walk", "1", "25", "30")), "")
        assertFalse(line.hasTotal)
        assertEquals(
            listOf("Discount for \"Dog walk\" (\$30.00) is larger than the line itself (\$25.00)."),
            line.lineProblems,
        )

        val sound = invoiceEditPreviewOf(listOf(InvoiceEditLine("Dog walk", "1", "25")), "5")
        assertTrue(sound.hasTotal)
        assertEquals(2000L, sound.totalCents)
    }

    // ── on screen ─────────────────────────────────────────────────────────────

    @Test
    fun theEditRefusalSitsUnderTheDueDateAndSaveIsDisabled() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                InvoiceEditDialog(draft().copy(dueDate = "2026-11-01"), null, false, {}, {}, {})
            }
        }
        waitForIdle()
        onNodeWithText(DUE_BEFORE_INVOICE_DATE, useUnmergedTree = true).assertExists()
        onNodeWithText("Save changes").assertIsNotEnabled()
    }

    @Test
    fun aGoodEditLeavesSaveEnabled() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                InvoiceEditDialog(draft().copy(dueDate = "2026-11-12"), null, false, {}, {}, {})
            }
        }
        waitForIdle()
        assertEquals(0, onAllNodesWithText(DUE_BEFORE_INVOICE_DATE, useUnmergedTree = true).fetchSemanticsNodes().size)
        onNodeWithText("Save changes").assertIsEnabled()
    }

    @Test
    fun theEditPreviewPrintsNoNegativeTotal() = runDesktopComposeUiTest {
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                InvoiceEditDialog(draft().copy(invoiceDiscountText = "77"), null, false, {}, {}, {})
            }
        }
        waitForIdle()
        onNodeWithText("Invoice discount (\$77.00) is larger than the subtotal (\$25.00).", useUnmergedTree = true)
            .assertExists()
        onNodeWithText("Total -", useUnmergedTree = true).assertExists()
        assertEquals(0, onAllNodesWithText("Total -\$52.00", useUnmergedTree = true).fetchSemanticsNodes().size)
    }

    @Composable
    private fun Composer(sessions: List<UninvoicedSession>) {
        NewInvoiceDialogContent(
            visible = true,
            picks = listOf(PICK_KINFOLK, KinfolkPick("kf1", "Ada Wren")),
            todayIso = "2026-11-05",
            onDismiss = {},
            onConfirm = {},
            loadUninvoiced = { _, _, _ ->
                WriteResult.Ok(UninvoicedSessionsResult(sessions, emptyList(), emptyList(), emptyList(), true, 5, false))
            },
            setDoNotInvoice = { _, _, _ -> error("not called in this test") },
            initialKinfolkId = "kf1",
        )
    }
    @Test
    fun aTooLargeDiscountOnNewInvoiceShowsNoTotalAndHoldsCreateBack() = runDesktopComposeUiTest {
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { Composer(listOf(walk)) } }
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText("Create invoice for 1 visit", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        onNode(hasContentDescription("Discount off the whole invoice ($)") and hasSetTextAction())
            .performScrollTo()
            .performTextInput("77")
        waitForIdle()
        onNodeWithText("Invoice discount (\$77.00) is larger than the subtotal (\$25.00).", useUnmergedTree = true)
            .assertExists()
        onNodeWithText("Total -", useUnmergedTree = true).assertExists()
        onNodeWithText("Create invoice for 1 visit").assertIsNotEnabled()
    }

    @Test
    fun lettersInTheBlankTotalAreRefusedUnderTheField() = runDesktopComposeUiTest {
        setContent { AuntieAppTheme(themeMode = ThemeMode.DARK) { Composer(emptyList()) } }
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText("Write a blank invoice instead", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithText("Write a blank invoice instead").performClick()
        waitForIdle()
        onNode(hasContentDescription("Total ($)") and hasSetTextAction()).performScrollTo().performTextInput("abc")
        waitForIdle()
        assertEquals(1, onAllNodesWithText(BLANK_TOTAL_PROBLEM, useUnmergedTree = true).fetchSemanticsNodes().size)
        onNodeWithText("Create invoice").assertIsNotEnabled()
    }
}
