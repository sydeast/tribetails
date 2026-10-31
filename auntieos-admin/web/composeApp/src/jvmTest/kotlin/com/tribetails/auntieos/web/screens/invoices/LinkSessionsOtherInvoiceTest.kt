package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.data.linkPickerOnOtherInvoice
import com.tribetails.auntieos.web.data.toggleLinkPick
import kotlinx.coroutines.runBlocking
import java.io.File
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1254: the desktop console's Link Sessions picker marks a visit another
 * invoice already bills, will not tick it, and shows the server's
 * `session_on_other_invoice` refusal verbatim. Same rule as admin web's
 * InvoiceLinkVisitsEditor and admin Android's picker.
 */
class LinkSessionsOtherInvoiceTest {

    @BeforeTest fun setUp() = JvmFirestoreFixtures.clear()
    @AfterTest fun tearDown() = JvmFirestoreFixtures.clear()

    private fun visit(id: String, invoiceId: String = "") = KinCareSession(_id = id, invoiceId = invoiceId)

    @Test
    fun onlyAVisitClaimedByADifferentInvoiceAndNotStoredIsMarked() {
        val stored = listOf("s1")
        assertTrue(linkPickerOnOtherInvoice(visit("s3", "invA"), "inv1", stored))
        assertTrue(linkPickerOnOtherInvoice(visit("s3", "  invA "), "inv1", stored))
        // Unclaimed: empty and whitespace are one state.
        assertFalse(linkPickerOnOtherInvoice(visit("s3", ""), "inv1", stored))
        assertFalse(linkPickerOnOtherInvoice(visit("s3", "   "), "inv1", stored))
        // A back-link to THIS invoice is a half-link, not another invoice.
        assertFalse(linkPickerOnOtherInvoice(visit("s3", " inv1 "), "inv1", stored))
        // Already in the stored set: stays togglable whatever its back-link says.
        assertFalse(linkPickerOnOtherInvoice(visit("s1", "invA"), "inv1", stored))
    }

    @Test
    fun theToggleWillNotTickAVisitOnAnotherInvoice() {
        val sessions = listOf(visit("s1"), visit("s2"), visit("s3", "invA"))
        val pending = setOf("s1")
        assertEquals(setOf("s1"), toggleLinkPick(pending, "s3", sessions, "inv1", listOf("s1")))
        assertEquals(setOf("s1", "s2"), toggleLinkPick(pending, "s2", sessions, "inv1", listOf("s1")))
    }

    @Test
    fun aStoredVisitWithAStrayBackLinkCanStillBeUntickedAndReticked() {
        val sessions = listOf(visit("s1", "invA"), visit("s2"))
        val stored = listOf("s1", "s2")
        val unticked = toggleLinkPick(setOf("s1", "s2"), "s1", sessions, "inv1", stored)
        assertEquals(setOf("s2"), unticked)
        assertEquals(setOf("s1", "s2"), toggleLinkPick(unticked, "s1", sessions, "inv1", stored))
    }

    @Test
    fun theOtherInvoiceRefusalComesBackVerbatimWithItsCode() = runBlocking {
        val refusal = "Already billed on another invoice: visit s3 is on invoice INV-7. Unlink it there first."
        JvmFirestoreFixtures.callableErrors = mapOf("linkInvoiceSessions" to refusal)
        JvmFirestoreFixtures.callableErrorCodes = mapOf("linkInvoiceSessions" to "session_on_other_invoice")
        val r = FirestoreClient().linkInvoiceSessions("inv1", listOf("s1", "s3"))
        assertTrue(r is WriteResult.Err, "$r")
        assertEquals(refusal, (r as WriteResult.Err).message)
        assertEquals("session_on_other_invoice", r.code)
        assertNull(JvmFirestoreFixtures.lastWrite, "a refused save must not fall back to a direct write")
    }

    /** The dialog is wired to the rule: the chip is disabled and the toggle guarded. */
    @Test
    fun theScreenUsesTheRuleForTheChipAndTheToggle() {
        val screen = File("src/commonMain/kotlin/com/tribetails/auntieos/web/screens/invoices/InvoiceDetailScreen.kt")
        assertTrue(screen.isFile, "screen source not found from ${File(".").absolutePath}")
        val t = screen.readText()
        assertTrue("linkPickerOnOtherInvoice(session, invoiceId, storedIds)" in t)
        assertTrue("enabled  = !elsewhere && !saveLoading" in t)
        assertTrue("toggleLinkPick(pendingIds, sid, allSessions, invoice._id, invoice.sessionIds)" in t)
        assertTrue("\" · on another invoice\"" in t)
    }
}
