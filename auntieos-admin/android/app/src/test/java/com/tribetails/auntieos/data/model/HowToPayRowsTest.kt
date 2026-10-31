package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * #1200: the Android invoice "How to pay" panel lists what the household is
 * offered, resolved the way the server's `resolvePayMethods` resolves it:
 * switch first, then handle or instructions, the invoice's own snapshot
 * before live settings, in the portal's order.
 *
 * Snapshots are the shape Firestore's `toObject()` hands an `Any?` field: a
 * map of strings, booleans and nested maps.
 */
class HowToPayRowsTest {

    private fun invoice(status: String = "open", snapshot: Any? = null) = Invoice(
        id = "inv1",
        invoiceNumber = "1042",
        total = 60.0,
        amountDue = 60.0,
        status = status,
        payMethodSettingsSnapshot = snapshot,
    )

    /** Venmo switched off with its handle kept, Zelle on with words, Check on with none. */
    private val live = BusinessSettings(
        venmoHandle = "@tribetails",
        paypalHandle = "paypal.me/tribetails",
        cashappHandle = "\$tribetails",
        paymentOptions = mapOf(
            "venmo" to mapOf("enabled" to false, "instructions" to ""),
            "zelle" to mapOf("enabled" to true, "instructions" to "  Zelle to the business line.  "),
            "check" to mapOf("enabled" to true, "instructions" to "   "),
            "klarna" to mapOf("enabled" to true),
        ),
    )

    private fun ids(rows: List<HowToPayRow>) = rows.map { it.methodId }

    @Test
    fun `a switched-off method is hidden even with its handle filled in`() {
        assertEquals(listOf("stripe", "paypal", "cashapp", "klarna", "zelle"), ids(howToPayRowsForInvoice(invoice(), live)))
    }

    @Test
    fun `rows carry the catalogue label and what the household is told`() {
        val rows = howToPayRowsForInvoice(invoice(), live).associateBy { it.methodId }
        assertEquals(HowToPayRow("stripe", "Credit card", HOW_TO_PAY_CHECKOUT_DETAIL), rows["stripe"])
        assertEquals(HowToPayRow("paypal", "PayPal", "paypal.me/tribetails"), rows["paypal"])
        assertEquals(HowToPayRow("cashapp", "Cash App", "\$tribetails"), rows["cashapp"])
        assertEquals(HowToPayRow("klarna", "Klarna", HOW_TO_PAY_CHECKOUT_DETAIL), rows["klarna"])
        assertEquals(HowToPayRow("zelle", "Zelle", "Zelle to the business line."), rows["zelle"])
    }

    @Test
    fun `a doc with no switches offers the four defaults in portal order`() {
        val legacy = BusinessSettings(venmoHandle = "tribetails", paypalHandle = "tribetails", cashappHandle = "\$tt")
        assertEquals(listOf("stripe", "venmo", "paypal", "cashapp"), ids(howToPayRowsForInvoice(invoice(), legacy)))
        // Card alone, with no handles at all: still offered, it needs nothing typed.
        assertEquals(listOf("stripe"), ids(howToPayRowsForInvoice(invoice(), BusinessSettings())))
        assertEquals(listOf("stripe"), ids(howToPayRowsForInvoice(invoice(), null)))
    }

    @Test
    fun `every enabled instructions method shows, in catalogue order`() {
        val options = linkedMapOf<String, Any?>("stripe" to mapOf("enabled" to false))
        listOf("other", "cash", "check", "banktransfer", "zelle", "affirm").forEach { id ->
            options[id] = mapOf("enabled" to true, "instructions" to "words for $id")
        }
        assertEquals(
            listOf("affirm", "zelle", "banktransfer", "check", "cash", "other"),
            ids(howToPayRowsForInvoice(invoice(), BusinessSettings(paymentOptions = options))),
        )
    }

    @Test
    fun `handles the server cannot link are left out`() {
        val odd = BusinessSettings(venmoHandle = "@", paypalHandle = "auntie@example.com", cashappHandle = "https://cash.app/\$tt")
        assertEquals(listOf("stripe", "cashapp"), ids(howToPayRowsForInvoice(invoice(), odd)))
    }

    @Test
    fun `instructions over the server cap are left out`() {
        val long = BusinessSettings(
            paymentOptions = mapOf(
                "zelle" to mapOf("enabled" to true, "instructions" to "x".repeat(MAX_PAYMENT_INSTRUCTIONS_LENGTH + 1)),
                "cash" to mapOf("enabled" to true, "instructions" to "y".repeat(MAX_PAYMENT_INSTRUCTIONS_LENGTH)),
            ),
        )
        assertEquals(listOf("stripe", "cash"), ids(howToPayRowsForInvoice(invoice(), long)))
    }

    @Test
    fun `the invoice snapshot wins over live settings`() {
        // Issued while Venmo was on and Zelle off; live settings have since flipped both.
        val snapshot = mapOf(
            "capturedAt" to "2026-10-01T12:00:00.000Z",
            "venmoHandle" to "@issued",
            "paypalHandle" to "auntie@example.com",
            "paymentOptions" to mapOf(
                "stripe" to mapOf("enabled" to false),
                "venmo" to mapOf("enabled" to true),
                "zelle" to mapOf("enabled" to false, "instructions" to "old"),
            ),
        )
        assertEquals(listOf(HowToPayRow("venmo", "Venmo", "@issued")), howToPayRowsForInvoice(invoice(snapshot = snapshot), live))
    }

    @Test
    fun `a snapshot with no switches resolves to the defaults, not to live`() {
        val snapshot = mapOf("capturedAt" to "2026-10-01T12:00:00.000Z", "venmoHandle" to "@issued", "cashappHandle" to 42L)
        assertEquals(listOf("stripe", "venmo"), ids(howToPayRowsForInvoice(invoice(snapshot = snapshot), live)))
    }

    @Test
    fun `a malformed snapshot falls back to live settings`() {
        val expected = ids(howToPayRowsForInvoice(invoice(), live))
        for (bad in listOf<Any?>("not a map", listOf(1, 2), null, 7L)) {
            assertEquals("$bad", expected, ids(howToPayRowsForInvoice(invoice(snapshot = bad), live)))
        }
    }

    @Test
    fun `nothing is offered on an invoice that owes nothing`() {
        for (status in listOf("paid", "PAID", "zero", "credit", "redeemed", "cancelled")) {
            assertEquals(status, emptyList<HowToPayRow>(), howToPayRowsForInvoice(invoice(status = status), live))
        }
        for (status in listOf("open", "draft", "quote", "")) {
            assertEquals(status, "stripe", howToPayRowsForInvoice(invoice(status = status), live).first().methodId)
        }
    }
}
