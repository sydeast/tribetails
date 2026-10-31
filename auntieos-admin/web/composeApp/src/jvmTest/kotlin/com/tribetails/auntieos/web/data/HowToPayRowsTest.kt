package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #1200: the desktop invoice "How to pay" panel lists what the household is
 * offered, resolved the way the server's `resolvePayMethods` resolves it:
 * switch first, then handle or instructions, the invoice's own snapshot
 * before live settings, in the portal's order.
 *
 * Invoices are decoded through the desktop REST codec from JSON, the way the
 * invoice list reads them, so the snapshot field is pinned end to end.
 */
class HowToPayRowsTest {

    private fun invoice(status: String = "open", snapshotJson: String? = null): Invoice =
        JvmFirestoreRest.codec.decodeFromString(
            Invoice.serializer(),
            buildString {
                append("""{"_id":"inv1","invoiceNumber":"1042","total":60.0,"amountDue":60.0,"status":"$status"""")
                if (snapshotJson != null) append(""","payMethodSettingsSnapshot":$snapshotJson""")
                append("}")
            },
        )

    /** Venmo switched off with its handle kept, Zelle on with words, Check on with none. */
    private val live = BusinessSettings(
        venmoHandle = "@tribetails",
        paypalHandle = "paypal.me/tribetails",
        cashappHandle = "\$tribetails",
        paymentOptions = buildJsonObject {
            putJsonObject("venmo") { put("enabled", false); put("instructions", "") }
            putJsonObject("zelle") { put("enabled", true); put("instructions", "  Zelle to the business line.  ") }
            putJsonObject("check") { put("enabled", true); put("instructions", "   ") }
            putJsonObject("klarna") { put("enabled", true) }
        },
    )

    private fun ids(rows: List<HowToPayRow>) = rows.map { it.methodId }

    @Test
    fun aSwitchedOffMethodIsHiddenEvenWithItsHandleFilledIn() {
        val rows = howToPayRowsForInvoice(invoice(), live)
        assertEquals(listOf("stripe", "paypal", "cashapp", "klarna", "zelle"), ids(rows))
    }

    @Test
    fun rowsCarryTheCatalogueLabelAndWhatTheHouseholdIsTold() {
        val rows = howToPayRowsForInvoice(invoice(), live).associateBy { it.methodId }
        assertEquals(HowToPayRow("stripe", "Credit card", HOW_TO_PAY_CHECKOUT_DETAIL), rows["stripe"])
        assertEquals(HowToPayRow("paypal", "PayPal", "paypal.me/tribetails"), rows["paypal"])
        assertEquals(HowToPayRow("cashapp", "Cash App", "\$tribetails"), rows["cashapp"])
        assertEquals(HowToPayRow("klarna", "Klarna", HOW_TO_PAY_CHECKOUT_DETAIL), rows["klarna"])
        assertEquals(HowToPayRow("zelle", "Zelle", "Zelle to the business line."), rows["zelle"])
    }

    @Test
    fun aDocWithNoSwitchesOffersTheFourDefaultsInPortalOrder() {
        val legacy = BusinessSettings(venmoHandle = "tribetails", paypalHandle = "tribetails", cashappHandle = "\$tt")
        assertEquals(listOf("stripe", "venmo", "paypal", "cashapp"), ids(howToPayRowsForInvoice(invoice(), legacy)))
        // Card alone, with no handles at all: still offered, it needs nothing typed.
        assertEquals(listOf("stripe"), ids(howToPayRowsForInvoice(invoice(), BusinessSettings())))
        assertEquals(listOf("stripe"), ids(howToPayRowsForInvoice(invoice(), null)))
    }

    @Test
    fun everyEnabledInstructionsMethodShowsInCatalogueOrder() {
        val all = BusinessSettings(
            paymentOptions = buildJsonObject {
                putJsonObject("stripe") { put("enabled", false) }
                listOf("other", "cash", "check", "banktransfer", "zelle", "affirm").forEach { id ->
                    putJsonObject(id) { put("enabled", true); put("instructions", "words for $id") }
                }
            },
        )
        assertEquals(
            listOf("affirm", "zelle", "banktransfer", "check", "cash", "other"),
            ids(howToPayRowsForInvoice(invoice(), all)),
        )
    }

    @Test
    fun handlesTheServerCannotLinkAreLeftOut() {
        val odd = BusinessSettings(venmoHandle = "@", paypalHandle = "auntie@example.com", cashappHandle = "https://cash.app/\$tt")
        assertEquals(listOf("stripe", "cashapp"), ids(howToPayRowsForInvoice(invoice(), odd)))
    }

    @Test
    fun instructionsOverTheServerCapAreLeftOut() {
        val long = BusinessSettings(
            paymentOptions = buildJsonObject {
                putJsonObject("zelle") { put("enabled", true); put("instructions", "x".repeat(MAX_PAYMENT_INSTRUCTIONS_LENGTH + 1)) }
                putJsonObject("cash") { put("enabled", true); put("instructions", "y".repeat(MAX_PAYMENT_INSTRUCTIONS_LENGTH)) }
            },
        )
        assertEquals(listOf("stripe", "cash"), ids(howToPayRowsForInvoice(invoice(), long)))
    }

    @Test
    fun theInvoiceSnapshotWinsOverLiveSettings() {
        // Issued while Venmo was on and Zelle off; live settings have since flipped both.
        val snapshot = """
            {"capturedAt":"2026-10-01T12:00:00.000Z","venmoHandle":"@issued","paypalHandle":"auntie@example.com",
             "paymentOptions":{"stripe":{"enabled":false},"venmo":{"enabled":true},"zelle":{"enabled":false,"instructions":"old"}}}
        """.trimIndent()
        val rows = howToPayRowsForInvoice(invoice(snapshotJson = snapshot), live)
        assertEquals(listOf(HowToPayRow("venmo", "Venmo", "@issued")), rows)
    }

    @Test
    fun aSnapshotWithNoSwitchesResolvesToTheDefaultsNotToLive() {
        val snapshot = """{"capturedAt":"2026-10-01T12:00:00.000Z","venmoHandle":"@issued","cashappHandle":42}"""
        assertEquals(listOf("stripe", "venmo"), ids(howToPayRowsForInvoice(invoice(snapshotJson = snapshot), live)))
    }

    @Test
    fun aMalformedSnapshotFallsBackToLiveSettings() {
        val expected = ids(howToPayRowsForInvoice(invoice(), live))
        for (bad in listOf("\"not a map\"", "[1,2]", "null", "7")) {
            assertEquals(expected, ids(howToPayRowsForInvoice(invoice(snapshotJson = bad), live)), bad)
        }
    }

    @Test
    fun nothingIsOfferedOnAnInvoiceThatOwesNothing() {
        for (status in listOf("paid", "PAID", "zero", "credit", "redeemed", "cancelled")) {
            assertEquals(emptyList(), howToPayRowsForInvoice(invoice(status = status), live), status)
        }
        for (status in listOf("open", "draft", "quote", "")) {
            assertEquals("stripe", howToPayRowsForInvoice(invoice(status = status), live).first().methodId, status)
        }
    }
}
