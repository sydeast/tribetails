package com.tribetails.auntieos.ui.admin

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResult
import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResultExcluded
import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResultSession
import com.tribetails.auntieos.data.contracts.SetSessionDoNotInvoiceResult
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Robolectric mount tests for the #408 composer.
 *
 * WHAT THESE GUARD is that the shape of the screen is the shape the issue asked
 * for: the work appears as soon as a household is chosen, the create button
 * counts the visits it is about to bill for, and the fields the issue named as
 * never-wanted are not on the dialog at all. The decisions behind each of those
 * are asserted exhaustively and purely in [InvoiceComposerTest]; this file
 * checks that they reach a screen.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w1080dp-h1920dp-xhdpi")
class NewInvoiceDialogTest {

    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private val kinfolk = listOf(Kinfolk(id = "kf1", firstName = "Jamie", lastName = "Halbrook"))

    private fun result(
        sessions: List<ListUninvoicedSessionsResultSession> = emptyList(),
        excluded: List<ListUninvoicedSessionsResultExcluded> = emptyList(),
        scanned: Long = 0L,
    ) = ListUninvoicedSessionsResult(
        sessions = sessions,
        unpriceable = emptyList(),
        unplaceable = emptyList(),
        excluded = excluded,
        rateCardLoaded = true,
        scanned = scanned,
        truncated = false,
    )

    private fun session(id: String, unitCents: Long? = 2500L) = ListUninvoicedSessionsResultSession(
        sessionId = id,
        kinfolkId = "kf1",
        serviceType = "Dog walk",
        durationMinutes = 30.0,
        startTime = "2026-08-11T15:00:00.000Z",
        unitCents = unitCents,
    )

    private fun mount(
        initialKinfolkId: String = "",
        initialKind: InvoiceCreateKind = InvoiceCreateKind.INVOICE,
        loaded: ListUninvoicedSessionsResult = result(),
        onConfirm: (NewInvoiceRequest) -> Unit = {},
        onOpenVisit: (String) -> Unit = {},
        visible: Boolean = true,
    ) {
        rule.setContent {
            AuntieOSTheme {
                NewInvoiceDialog(
                    visible = visible,
                    kinfolk = kinfolk,
                    todayIso = "2026-08-19",
                    initialKind = initialKind,
                    initialKinfolkId = initialKinfolkId,
                    onDismiss = {},
                    onConfirm = onConfirm,
                    onOpenVisit = onOpenVisit,
                    loadUninvoiced = { _, _, _ -> Result.success(loaded) },
                    setDoNotInvoice = { ids, doNotInvoice, _ ->
                        Result.success(
                            SetSessionDoNotInvoiceResult(
                                ok = true,
                                doNotInvoice = doNotInvoice,
                                changed = ids,
                                unchanged = emptyList(),
                            ),
                        )
                    },
                )
            }
        }
        rule.waitForIdle()
    }

    @Test
    fun `it opens on one question, and the fields 408 removed are not on it`() {
        mount()

        rule.onNodeWithText("New invoice").assertExists()
        rule.onNodeWithText("HOUSEHOLD").assertExists()
        rule.onNodeWithText("Pick a household and its un-invoiced work appears here, ready to tick.").assertExists()
        rule.onNodeWithText("Cancel").assertExists()

        // The named-and-removed fields. Each was either inherited, derived,
        // computed or server-assigned, and each was being asked as a question.
        rule.onNodeWithText("INVOICE NUMBER").assertDoesNotExist()
        rule.onNodeWithText("AMOUNT DUE ($)").assertDoesNotExist()
        rule.onNodeWithText("CLIENT, OPTIONAL").assertDoesNotExist()
        rule.onNodeWithText("ADDRESS, OPTIONAL").assertDoesNotExist()
        rule.onNodeWithText("TERMS, OPTIONAL").assertDoesNotExist()
        rule.onNodeWithText("DISCOUNT, OPTIONAL").assertDoesNotExist()
        rule.onNodeWithText("STATUS").assertDoesNotExist()
    }

    @Test
    fun `terms are a structured choice and the due date is stated, not typed`() {
        mount()
        rule.onNodeWithText("TERMS").assertExists()
        // The opening rule, in the operator's words rather than as "Net 0".
        rule.onNodeWithText("Due on receipt").assertExists()
        rule.onNodeWithText("DUE DATE (YYYY-MM-DD)").assertExists()
    }

    @Test
    fun `the create button is disabled with its reason stated rather than hidden`() {
        mount()
        rule.onNodeWithText("Create invoice").assertExists()
        rule.onNodeWithText("Pick a household first.").assertExists()
    }

    @Test
    fun `picking a household loads its work with every visit ticked and counted`() {
        mount(initialKinfolkId = "kf1", loaded = result(sessions = listOf(session("s1"), session("s2")), scanned = 2L))

        rule.onNodeWithText("2 of 2 un-invoiced visits selected for Jamie Halbrook.").assertExists()
        rule.onNodeWithText("Create invoice for 2 visits").assertExists()
        // No find step and no date range to guess at: the range only appears
        // when the server says its page cap was reached.
        rule.onNodeWithText("VISITS FROM").assertDoesNotExist()
    }

    @Test
    fun `do not invoice sits beside the selection with the same verb`() {
        mount(initialKinfolkId = "kf1", loaded = result(sessions = listOf(session("s1")), scanned = 1L))
        rule.onNodeWithText("Do not invoice this visit").assertExists()
    }

    @Test
    fun `excluded work comes back in its own list with a way to undo it`() {
        mount(
            initialKinfolkId = "kf1",
            loaded = result(
                sessions = listOf(session("s1")),
                excluded = listOf(
                    ListUninvoicedSessionsResultExcluded(
                        sessionId = "s9",
                        kinfolkId = "kf1",
                        serviceType = "Drop-in",
                        startTime = "2026-08-02T15:00:00.000Z",
                        reason = "comped",
                    ),
                ),
                scanned = 2L,
            ),
        )
        rule.onNodeWithText("1 completed visit is marked do not invoice, so it is not on the list above.")
            .assertExists()
        rule.onNodeWithText("Put it back").assertExists()
    }

    @Test
    fun `a household with nothing logged names it, says what was checked, and offers the blank invoice`() {
        mount(initialKinfolkId = "kf1", loaded = result(scanned = 12L))

        rule.onNodeWithText("No un-invoiced completed visits for Jamie Halbrook. 12 visits were checked.")
            .assertExists()
        rule.onNodeWithText("Write a blank invoice instead").assertExists()
    }

    @Test
    fun `the blank invoice is the one path where a total is typed, and it says so`() {
        mount(initialKinfolkId = "kf1", loaded = result(scanned = 12L))
        rule.onNodeWithText("Write a blank invoice instead").performClick()
        rule.waitForIdle()

        rule.onNodeWithText("TOTAL ($)").assertExists()
        rule.onNodeWithText(
            "A blank invoice, with a total you type. Nothing on it is linked to logged work, so nothing " +
                "here can tell whether this household has already been billed for it.",
        ).assertExists()
        rule.onNodeWithText("Bill this household's logged work instead").assertExists()
    }

    @Test
    fun `an invoice created from work lands as a draft and says nothing has been sent`() {
        mount(initialKinfolkId = "kf1", loaded = result(sessions = listOf(session("s1")), scanned = 1L))
        rule.onNodeWithText(
            "This lands as a draft. Nothing reaches Jamie Halbrook until you send it from the invoice itself.",
        ).assertExists()
    }

    @Test
    fun `creating hands back bound lines, a terms code and no typed total`() {
        var captured: NewInvoiceRequest? = null
        mount(
            initialKinfolkId = "kf1",
            loaded = result(sessions = listOf(session("s1"), session("s2")), scanned = 2L),
            onConfirm = { captured = it },
        )
        rule.onNodeWithText("Create invoice for 2 visits").performClick()
        rule.waitForIdle()

        val request = captured
        assertNotNull("The create button did not produce a request", request)
        requireNotNull(request)
        assertEquals(InvoiceCreateKind.INVOICE, request.kind)
        assertEquals("due_on_receipt", request.termsCode)
        assertEquals(2, request.lineItems?.size)
        assertTrue(request.lineItems!!.all { it.sessionId.isNotBlank() })
        assertEquals(listOf("s1", "s2"), request.invoice.sessionIds)
        // Assigned by the server from a transactional counter, never typed.
        assertEquals("", request.invoice.invoiceNumber)
        assertEquals("draft", request.invoice.status)
        // The amount due on an invoice nobody has paid IS its total.
        assertEquals(50.0, request.invoice.total, 0.0001)
        assertEquals(50.0, request.invoice.amountDue, 0.0001)
    }

    @Test
    fun `the quote path is the same composer in quote mode`() {
        mount(initialKinfolkId = "kf1", initialKind = InvoiceCreateKind.QUOTE, loaded = result(scanned = 0L))
        rule.onNodeWithText("New quote").assertExists()
        rule.onNodeWithText("Create quote").assertExists()
        rule.onNodeWithText("Send to kinfolk").assertExists()
    }

    @Test
    fun `hidden when not visible`() {
        mount(visible = false)
        rule.onNodeWithText("New invoice").assertDoesNotExist()
    }
}
