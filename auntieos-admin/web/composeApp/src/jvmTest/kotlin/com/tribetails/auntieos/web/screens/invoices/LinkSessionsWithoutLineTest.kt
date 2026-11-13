package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.InvoiceSessionLinkOutcome
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.LINK_ADDS_NO_PRICE_TEXT
import com.tribetails.auntieos.web.data.decodeInvoiceSessionLinkOutcome
import com.tribetails.auntieos.web.data.invoiceSessionLinksSavedText
import com.tribetails.auntieos.web.data.linkPickerBilledIds
import com.tribetails.auntieos.web.data.toggleLinkPick
import com.tribetails.auntieos.web.screens.ServiceCatalog
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #2091: the desktop console's Link Sessions dialog says linking adds no price,
 * reports which linked visits the server says carry no line, and keeps a visit
 * a line on the invoice bills ticked. Same words and rules as admin web and
 * admin Android.
 */
class LinkSessionsWithoutLineTest {

    @Test
    fun decodesLinkedWithoutLineAndToleratesAnOlderServer() {
        val o = decodeInvoiceSessionLinkOutcome(
            """{"ok":true,"invoiceId":"inv1","sessionIds":["s1","s2"],"added":["s2"],"removed":[],"linkedWithoutLine":["s2"],"status":"draft","editScope":"all"}""",
            "inv1",
            listOf("s1", "s2"),
        )
        assertEquals(listOf("s2"), o.linkedWithoutLine)
        val older = decodeInvoiceSessionLinkOutcome("""{"ok":true,"invoiceId":"inv1","added":["s2"]}""", "inv1", listOf("s2"))
        assertEquals(emptyList(), older.linkedWithoutLine)
    }

    @Test
    fun theSavedTextSaysTheLinkedVisitsPriceWasNotAdded() {
        fun o(added: List<String>, removed: List<String>, withoutLine: List<String>) =
            InvoiceSessionLinkOutcome("inv1", emptyList(), added, removed, "open", "all", withoutLine)
        assertEquals(
            "Visits saved: 1 linked. The linked visit no longer shows as un-invoiced, and its price was not added to this invoice.",
            invoiceSessionLinksSavedText(o(listOf("s2"), emptyList(), listOf("s2"))),
        )
        assertEquals(
            "Visits saved: 2 linked, 1 unlinked. The 2 linked visits no longer show as un-invoiced, and their prices were not added to this invoice.",
            invoiceSessionLinksSavedText(o(listOf("a", "c"), listOf("b"), listOf("a", "c"))),
        )
        // A visit that already had no line before this save is not news.
        assertEquals("Visits saved: 1 unlinked.", invoiceSessionLinksSavedText(o(emptyList(), listOf("b"), listOf("old"))))
        assertEquals("Visits saved: 1 linked.", invoiceSessionLinksSavedText(o(listOf("a"), emptyList(), emptyList())))
    }

    @Test
    fun billedIdsComeFromTheRawLinesAndJunkReadsAsNone() {
        val lines = Json.parseToJsonElement(
            """[{"description":"Walk","qty":1,"unitCents":4500,"sessionId":" s1 "},{"description":"Key cutting","qty":1,"unitCents":900},"junk",{"sessionId":7}]""",
        )
        assertEquals(setOf("s1"), linkPickerBilledIds(lines))
        assertEquals(emptySet(), linkPickerBilledIds(null))
        assertEquals(emptySet(), linkPickerBilledIds(Json.parseToJsonElement("""{"not":"a list"}""")))
    }

    @Test
    fun aVisitALineBillsStaysTickedAndAnotherLinkedVisitCanBeUnticked() {
        val sessions = listOf(KinCareSession(_id = "s1", invoiceId = "inv1"), KinCareSession(_id = "s2", invoiceId = "inv1"))
        val pending = setOf("s1", "s2")
        val stored = listOf("s1", "s2")
        assertEquals(pending, toggleLinkPick(pending, "s1", sessions, "inv1", stored, setOf("s1")))
        assertEquals(setOf("s1"), toggleLinkPick(pending, "s2", sessions, "inv1", stored, setOf("s1")))
    }
    @Test
    fun aBilledVisitTheStoredSetLeftOutCanBeTickedAndUntickedAgain() {
        val sessions = listOf(KinCareSession(_id = "s1"))
        val ticked = toggleLinkPick(emptySet(), "s1", sessions, "inv1", emptyList(), setOf("s1"))
        assertEquals(setOf("s1"), ticked)
        assertEquals(emptySet(), toggleLinkPick(ticked, "s1", sessions, "inv1", emptyList(), setOf("s1")))
    }

    @Test
    fun theChipSaysWhyABilledVisitStaysLinked() {
        val label = linkPickerChipLabel("Walk", "2026-06-02", elsewhere = false, cancelled = false, catalog = ServiceCatalog(), billedHere = true)
        assertTrue(label.endsWith(" · billed on a line of this invoice, remove the line in Edit to unlink it"))
        val locked = linkPickerChipLabel(
            "Walk", "2026-06-02", elsewhere = false, cancelled = false, catalog = ServiceCatalog(), billedHere = true, linesEditable = false,
        )
        assertTrue(locked.endsWith(" · billed on a line of this invoice, and its lines are locked"))
        assertTrue("Edit" !in locked)
    }

    @Test
    fun theWarningSaysThePriceIsNotAdded() {
        assertTrue(LINK_ADDS_NO_PRICE_TEXT.contains("its price is not added"))
    }
}
