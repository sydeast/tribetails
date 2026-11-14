package com.tribetails.auntieos.web.screens.invoices

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteractionsProvider
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.decodeUnarchiveNotice
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #2168 review, desktop console half.
 *
 * The console lists archived invoices with the rest, and before this it offered
 * Edit, Link sessions and the row's Review & send on them, all of which the
 * server now refuses until the invoice is restored. It had no Restore at all.
 * Now an archived invoice says so, offers Restore (the `unarchiveInvoice`
 * callable) and none of the three, and a restore that could not take every
 * visit back says which in a warning that stays until dismissed, as on web and
 * Android.
 */
@OptIn(ExperimentalTestApi::class)
class InvoiceArchivedReadOnlyTest {

    @BeforeTest fun setUp() = JvmFirestoreFixtures.clear()
    @AfterTest fun tearDown() = JvmFirestoreFixtures.clear()

    private fun SemanticsNodeInteractionsProvider.shown(text: String): Boolean =
        onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    private fun SemanticsNodeInteractionsProvider.described(text: String): Boolean =
        onAllNodesWithContentDescription(text, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    private fun draft(archived: Boolean) = Invoice(
        _id = "inv1",
        kinfolkId = "k1",
        kinfolkName = "Wanda Thorne",
        invoiceNumber = "1029",
        status = "draft",
        editScope = "all",
        total = 45.0,
        amountDue = 45.0,
        archivedAt = if (archived) JsonPrimitive("2026-07-25T00:00:00Z") else null,
    )

    private fun render(invoice: Invoice, check: androidx.compose.ui.test.ComposeUiTest.() -> Unit) = runDesktopComposeUiTest {
        JvmFirestoreFixtures.invoices = listOf(invoice)
        JvmFirestoreFixtures.sessionsForKinfolk = emptyList()
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                InvoiceDetailScreen(invoiceId = "inv1")
            }
        }
        waitUntil(timeoutMillis = 10_000) { shown("Download PDF") }
        check()
    }

    @Test
    fun anArchivedInvoiceOffersRestoreAndNoEditOrLink() = render(draft(archived = true)) {
        assertTrue(shown("Archived"), "the archived notice")
        assertTrue(shown("Restore"))
        assertFalse(shown("Edit"))
        assertFalse(shown("Link sessions"))
        assertFalse(described("Edit linked sessions"))
    }

    @Test
    fun theSameInvoiceNotArchivedOffersEditAndLinkAndNoRestore() = render(draft(archived = false)) {
        assertTrue(shown("Edit"))
        assertTrue(shown("Link sessions"))
        assertTrue(described("Edit linked sessions"))
        assertFalse(shown("Restore"))
        assertFalse(shown("Archived"))
    }

    @Test
    fun aRestoreThatCouldNotTakeAVisitBackStaysUntilDismissed() {
        val notice = "1 visit could not be taken back: the visit on 2026-06-02 is now on invoice 1042. " +
            "Its line is still on this draft, so remove it in Edit before sending the draft."
        JvmFirestoreFixtures.callableResponses = mapOf(
            "unarchiveInvoice" to
                """{"ok":true,"invoiceId":"inv1","reclaimedSessionIds":[],"notReclaimed":[],"notice":${Json.encodeToString(JsonPrimitive.serializer(), JsonPrimitive(notice))}}""",
        )
        render(draft(archived = true)) {
            onNodeWithText("Restore").performClick()
            waitUntil(timeoutMillis = 10_000) { shown("Restore invoice") }
            onNodeWithText("Restore invoice").performClick()
            val text = "Invoice restored to the working list. $notice"
            waitUntil(timeoutMillis = 10_000) { shown(text) }
            assertEquals("unarchiveInvoice", JvmFirestoreFixtures.lastCallableName)
            assertTrue(shown("Done, but not all of it"))

            mainClock.advanceTimeBy(10_000L)
            waitForIdle()
            assertTrue(shown(text), "still on screen well past a toast's life")

            onAllNodesWithContentDescription("Dismiss", useUnmergedTree = true)[0].performClick()
            waitForIdle()
            assertFalse(shown(text))
        }
    }

    @Test
    fun unarchiveSendsTheInvoiceIdAndAnswersTheNotice() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("unarchiveInvoice" to """{"ok":true,"invoiceId":"inv1","notice":"x"}""")
        val r = FirestoreClient().unarchiveInvoice("inv1")
        assertEquals(WriteResult.Ok("x"), r)
        val sent = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject
        assertEquals(setOf("invoiceId"), sent.keys)
        assertEquals("inv1", sent["invoiceId"]!!.jsonPrimitive.content)
        assertNull(JvmFirestoreFixtures.lastWrite, "no direct REST write")
    }

    @Test
    fun aRefusalComesBackVerbatim() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("unarchiveInvoice" to "This invoice is not archived.")
        val r = FirestoreClient().unarchiveInvoice("inv1")
        assertTrue(r is WriteResult.Err && r.message.contains("This invoice is not archived."), "$r")
    }

    @Test
    fun theNoticeDecodesFailSoft() {
        assertEquals("", decodeUnarchiveNotice("""{"ok":true}"""))
        assertEquals("", decodeUnarchiveNotice("not json"))
        assertEquals("a", decodeUnarchiveNotice("""{"notice":"a"}"""))
        assertEquals("Invoice restored to the working list.", invoiceRestoredText(""))
    }

    @Test
    fun anArchivedDraftsRowOffersNoReviewAndSend() {
        assertEquals(InvoiceAction.REVIEW_AND_SEND, invoiceRowActionOrNull(draft(archived = false)))
        assertNull(invoiceRowActionOrNull(draft(archived = true)))
        assertEquals(emptyList(), invoiceActionsOffered(InvoiceState.DRAFT, archived = true))
        for (s in InvoiceState.values().toList() + listOf(null)) {
            // #2090: Send reminder goes too; the server refuses it on an archived invoice.
            assertEquals(
                invoiceActionsFor(s) - InvoiceAction.REVIEW_AND_SEND - InvoiceAction.SEND_REMINDER,
                invoiceActionsOffered(s, archived = true),
            )
        }
        assertEquals(listOf(InvoiceAction.RECORD_PAYMENT), invoiceActionsOffered(InvoiceState.OPEN, archived = true))
    }
}
