package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.Invoice
import com.tribetails.auntieos.web.data.decodeWrittenOffCents
import com.tribetails.auntieos.web.data.writeOffInvoicePayload
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * #2090 on the desktop console: the owner writes off what is left on an open
 * invoice behind a confirm naming the household, the invoice and the amount,
 * in the same words as web and Android. Archiving is only tidying, and the
 * console has no Archive of its own.
 */
class InvoiceWriteOffTest {

    private fun decode(json: String): Invoice = Json { ignoreUnknownKeys = true }.decodeFromString(Invoice.serializer(), json)

    @Test
    fun writeOffIsOfferedOnlyOnAnOpenInvoiceWithMoneyOwedThatIsNotArchived() {
        assertEquals(900L, invoiceWriteOffOwedCents(Invoice(_id = "i1", status = "open", amountDue = 9.0)))
        for (status in listOf("draft", "quote", "paid", "cancelled", "credit", "redeemed", "zero", "written_off", "")) {
            assertNull(invoiceWriteOffOwedCents(Invoice(_id = "i1", status = status, amountDue = 9.0)), status)
        }
        assertNull(invoiceWriteOffOwedCents(Invoice(_id = "i1", status = "open", amountDue = 0.0)))
        assertNull(invoiceWriteOffOwedCents(decode("""{"_id":"i1","status":"open","amountDue":9.0,"archivedAt":"ts"}""")))
    }

    @Test
    fun theConfirmNamesTheHouseholdTheInvoiceAndTheAmount() {
        assertEquals(
            "Write off \$9.00 on invoice 1027 for The Whitfields? The household will no longer be asked to pay it, " +
                "and it stops counting as outstanding. It is not recorded as a payment or as account credit, and it " +
                "cannot be undone.",
            writeOffConfirmText("The Whitfields", "1027", 900L),
        )
        assertEquals(
            "Balance of \$9.00 written off. The household is no longer asked to pay it, and the invoice can be archived now.",
            writeOffNoticeText(900L),
        )
    }

    @Test
    fun aWrittenOffInvoiceReadsAsItselfAndNamesTheAmount() {
        val inv = decode("""{"_id":"i1","status":"written_off","total":40.0,"amountDue":0.0,"writtenOffCents":3000}""")
        assertEquals(InvoiceState.WRITTEN_OFF, invoiceStateOrNull(inv))
        assertEquals(3000L, invoiceWrittenOffCentsOf(inv))
        val badge = invoiceDetailBadgeFor(inv, "2026-11-13")
        assertEquals("WRITTEN OFF", badge.label)
        assertEquals("\$30.00 written off", badge.amountTrend)
        assertEquals("Written off", invoiceChipLabel(inv, "2026-11-13"))
        assertEquals(emptyList(), invoiceActionsFor(invoiceStateOrNull(inv)))
        assertEquals(listOf("i1"), listOf(inv).filter { invoiceMatchesFilter(it, InvoiceFilter.All, "2026-11-13") }.map { it._id })
        assertEquals(emptyList(), listOf(inv).filter { invoiceMatchesFilter(it, InvoiceFilter.Paid, "2026-11-13") })
    }

    @Test
    fun theCallCarriesTheAmountTheConfirmShowed() {
        val payload = writeOffInvoicePayload("i1", 900L)
        assertEquals(setOf("invoiceId", "amountCents"), payload.keys)
        assertEquals(JsonPrimitive("i1"), payload["invoiceId"])
        assertEquals(JsonPrimitive(900L), payload["amountCents"])
        assertEquals(900L, decodeWrittenOffCents("""{"ok":true,"invoiceId":"i1","writeOffId":"w1","writtenOffCents":900}"""))
        assertEquals(0L, decodeWrittenOffCents("not json"))
    }
}
