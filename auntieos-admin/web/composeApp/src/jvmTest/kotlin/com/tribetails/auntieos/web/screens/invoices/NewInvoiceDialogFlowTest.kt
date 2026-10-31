package com.tribetails.auntieos.web.screens.invoices

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.DoNotInvoiceResult
import com.tribetails.auntieos.web.data.UninvoicedExcluded
import com.tribetails.auntieos.web.data.UninvoicedSession
import com.tribetails.auntieos.web.data.UninvoicedSessionsResult
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/**
 * #1178: the desktop composer driven end to end with fake callables. A picked
 * household loads its un-invoiced visits ticked, the create button counts them,
 * pressing it hands over a draft request built from those visits, and marking
 * visits do not invoice calls the callable and reloads the list.
 */
@OptIn(ExperimentalTestApi::class)
class NewInvoiceDialogFlowTest {

    private val picks = listOf(PICK_KINFOLK, KinfolkPick("kf1", "Ada Wren"))

    private val walk = UninvoicedSession("s1", "kf1", "Dog walk", 30.0, "2026-10-02T15:00:00.000Z", 2500L)
    private val sit = UninvoicedSession("s2", "kf1", "Drop-in", 20.0, "2026-10-09T09:00:00.000Z", 1800L)

    private fun result(sessions: List<UninvoicedSession>, excluded: List<UninvoicedExcluded> = emptyList()) =
        UninvoicedSessionsResult(sessions, emptyList(), emptyList(), excluded, true, 5, false)

    @Test
    fun pickedHouseholdsVisitsLoadTickedAndCreateADraftFromThem() = runDesktopComposeUiTest {
        val loads = mutableListOf<String>()
        var confirmed: NewInvoiceRequest? = null
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                NewInvoiceDialogContent(
                    visible = true,
                    picks = picks,
                    todayIso = "2026-10-20",
                    onDismiss = {},
                    onConfirm = { confirmed = it },
                    loadUninvoiced = { id, _, _ -> loads += id; WriteResult.Ok(result(listOf(walk, sit))) },
                    setDoNotInvoice = { _, _, _ -> error("not called in this test") },
                    initialKinfolkId = "kf1",
                )
            }
        }
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText("Create invoice for 2 visits", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        assertEquals(listOf("kf1"), loads)
        onNodeWithText("2 of 2 un-invoiced visits selected for Ada Wren.", useUnmergedTree = true).assertExists()
        onNodeWithText("Total $43.00", useUnmergedTree = true).assertExists()
        // No typed number, total or status at creation.
        assertEquals(0, onAllNodesWithText("Invoice number", useUnmergedTree = true).fetchSemanticsNodes().size)
        assertEquals(0, onAllNodesWithText("Status", useUnmergedTree = true).fetchSemanticsNodes().size)

        onNodeWithText("Select none").performClick()
        waitForIdle()
        onNodeWithText("Create invoice").assertIsNotEnabled()
        onNodeWithText("Tick the work this invoice covers, or add a line of your own.", useUnmergedTree = true).assertExists()

        onNodeWithText("Select all").performClick()
        waitForIdle()
        onNodeWithText("Create invoice for 2 visits").assertIsEnabled().performClick()
        waitForIdle()

        val r = assertNotNull(confirmed, "create did not hand over a request")
        assertEquals("draft", r.invoice.status)
        assertEquals("", r.invoice.invoiceNumber)
        assertEquals("due_on_receipt", r.termsCode)
        assertEquals("2026-10-20", r.invoice.dueDate)
        assertEquals(43.0, r.invoice.total)
        assertEquals(listOf("s1", "s2"), r.lineItems!!.map { it.sessionId })
    }

    @Test
    fun markingVisitsDoNotInvoiceCallsTheCallableAndReloads() = runDesktopComposeUiTest {
        val calls = mutableListOf<Triple<List<String>, Boolean, String>>()
        var marked = false
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                NewInvoiceDialogContent(
                    visible = true,
                    picks = picks,
                    todayIso = "2026-10-20",
                    onDismiss = {},
                    onConfirm = {},
                    loadUninvoiced = { _, _, _ ->
                        WriteResult.Ok(
                            if (marked) {
                                result(emptyList(), listOf(UninvoicedExcluded("s1", "kf1", "Dog walk", walk.startTime, ""), UninvoicedExcluded("s2", "kf1", "Drop-in", sit.startTime, "")))
                            } else {
                                result(listOf(walk, sit))
                            },
                        )
                    },
                    setDoNotInvoice = { ids, flag, reason ->
                        calls += Triple(ids, flag, reason)
                        marked = true
                        WriteResult.Ok(DoNotInvoiceResult(true, flag, ids, emptyList()))
                    },
                    initialKinfolkId = "kf1",
                )
            }
        }
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText("Do not invoice these 2 visits", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        // Armed, then confirmed: the first press opens the reason step.
        onNodeWithText("Do not invoice these 2 visits").performClick()
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText("Keep them billable", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        assertEquals(0, calls.size)
        onNodeWithText("Do not invoice these 2 visits").performClick()
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText("2 visits are marked do not invoice, and off this list until you put them back.", useUnmergedTree = true)
                .fetchSemanticsNodes().isNotEmpty()
        }
        assertEquals(listOf(Triple(listOf("s1", "s2"), true, "")), calls)
        onNodeWithText(excludedWorkLine(2), useUnmergedTree = true).assertExists()
        onNodeWithText("Write a blank invoice instead", useUnmergedTree = true).assertExists()
    }

    @Test
    fun anExcludedVisitCanBePutBack() = runDesktopComposeUiTest {
        val calls = mutableListOf<Pair<List<String>, Boolean>>()
        var putBack = false
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                NewInvoiceDialogContent(
                    visible = true,
                    picks = picks,
                    todayIso = "2026-10-20",
                    onDismiss = {},
                    onConfirm = {},
                    loadUninvoiced = { _, _, _ ->
                        WriteResult.Ok(
                            if (putBack) {
                                result(listOf(walk, sit))
                            } else {
                                result(listOf(sit), listOf(UninvoicedExcluded("s1", "kf1", "Dog walk", walk.startTime, "comped")))
                            },
                        )
                    },
                    setDoNotInvoice = { ids, flag, _ ->
                        calls += ids to flag
                        putBack = true
                        WriteResult.Ok(DoNotInvoiceResult(true, flag, ids, emptyList()))
                    },
                    initialKinfolkId = "kf1",
                )
            }
        }
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText("Put it back", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithText(excludedWorkLine(1), useUnmergedTree = true).assertExists()
        onNodeWithText("Put it back").performClick()
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText("Create invoice for 2 visits", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        assertEquals(listOf(listOf("s1") to false), calls)
        onNodeWithText(exclusionNotice(1, false), useUnmergedTree = true).assertExists()
    }
    @Test
    fun aHouseholdWithNoWorkGetsABlankDraftWithATypedTotal() = runDesktopComposeUiTest {
        var confirmed: NewInvoiceRequest? = null
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                NewInvoiceDialogContent(
                    visible = true,
                    picks = picks,
                    todayIso = "2026-10-20",
                    onDismiss = {},
                    onConfirm = { confirmed = it },
                    loadUninvoiced = { _, _, _ -> WriteResult.Ok(result(emptyList())) },
                    setDoNotInvoice = { _, _, _ -> error("not called in this test") },
                    initialKinfolkId = "kf1",
                )
            }
        }
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText("Write a blank invoice instead", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        onNodeWithText("Write a blank invoice instead").performClick()
        waitForIdle()
        onNodeWithText("Create invoice").assertIsNotEnabled()
        onNode(hasContentDescription("Total ($)") and hasSetTextAction()).performScrollTo().performTextInput("120.00")
        waitForIdle()
        onNodeWithText("Create invoice").assertIsEnabled().performClick()
        waitForIdle()
        val r = assertNotNull(confirmed, "create did not hand over a request")
        assertEquals("draft", r.invoice.status)
        assertEquals(120.0, r.invoice.total)
        assertEquals(120.0, r.invoice.amountDue)
        assertNull(r.lineItems, "the blank path sends no lineItems key at all")
        assertEquals("due_on_receipt", r.termsCode)
    }
}
