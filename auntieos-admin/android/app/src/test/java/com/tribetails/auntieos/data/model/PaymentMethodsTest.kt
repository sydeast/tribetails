package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * ISSUE #1177: the Payment options editor on Android, away from Compose.
 *
 * The save path under test is the real one: [withPaymentDraft] builds the
 * edited model, and [businessSettingsFieldChanges] turns it into the map
 * `AuntieRepository.updateBusinessSettingsFields` writes under
 * `SetOptions.merge()`.
 */
class PaymentMethodsTest {

    /** A `paymentOptions` map exactly as the web panel writes it, plus keys this client does not model. */
    private fun webWrittenOptions(): Map<String, Any?> = linkedMapOf(
        "stripe" to mapOf("enabled" to true, "instructions" to ""),
        "venmo" to mapOf("enabled" to false, "instructions" to ""),
        "paypal" to mapOf("enabled" to true, "instructions" to ""),
        "cashapp" to mapOf("enabled" to true, "instructions" to ""),
        "klarna" to mapOf("enabled" to false, "instructions" to ""),
        "affirm" to mapOf("enabled" to false, "instructions" to ""),
        // An extra field on a known entry: must survive any save from here.
        "zelle" to mapOf("enabled" to true, "instructions" to "Zelle to the business line, invoice number in the note.", "addedBy" to "web"),
        "banktransfer" to mapOf("enabled" to false, "instructions" to ""),
        "check" to mapOf("enabled" to true, "instructions" to "Payable to the business, handed over at pickup."),
        // Off, but its words are kept for when it comes back on.
        "cash" to mapOf("enabled" to false, "instructions" to "Exact change at pickup."),
        "other" to mapOf("enabled" to false, "instructions" to ""),
        // An id from a newer build that this client does not know.
        "applepay" to mapOf("enabled" to true),
    )

    private val loaded = BusinessSettings(
        businessName = "Tribe Tails",
        venmoHandle = "@tribetails",
        paypalHandle = "paypal.me/tribetails",
        cashappHandle = "\$tribetails",
        weatherLocation = "Austin, TX",
        paymentOptions = webWrittenOptions(),
    )

    private fun draftWith(settings: BusinessSettings, id: String, change: (PaymentOptionDraft) -> PaymentOptionDraft): PaymentDraft {
        val draft = paymentDraftOf(settings)
        return draft.copy(options = draft.options + (id to change(draft.options.getValue(id))))
    }

    @Suppress("UNCHECKED_CAST")
    private fun writtenOptions(changes: Map<String, Any?>): Map<String, Map<String, Any?>> =
        (changes["paymentOptions"] ?: error("paymentOptions was not written: $changes")) as Map<String, Map<String, Any?>>

    // ── reading what the web wrote ───────────────────────────────────────────

    @Test
    fun `the editor opens on the web's switches and instructions`() {
        val draft = paymentDraftOf(loaded)
        assertEquals(PAYMENT_METHOD_CATALOGUE.map { it.id }, draft.options.keys.toList())
        assertEquals(PaymentOptionDraft(false, ""), draft.options["venmo"])
        assertEquals(PaymentOptionDraft(true, "Zelle to the business line, invoice number in the note."), draft.options["zelle"])
        assertEquals(PaymentOptionDraft(false, "Exact change at pickup."), draft.options["cash"])
        assertEquals("@tribetails", draft.handles[PaymentHandleField.VENMO])
    }

    @Test
    fun `absent is not off - a doc with no switches resolves to each method's default`() {
        val draft = paymentDraftOf(BusinessSettings())
        for (method in PAYMENT_METHOD_CATALOGUE) {
            assertEquals(method.id, method.defaultEnabled, draft.options.getValue(method.id).enabled)
        }
        assertEquals(setOf("stripe", "venmo", "paypal", "cashapp"), draft.options.filterValues { it.enabled }.keys)
    }

    @Test
    fun `malformed entries read as absent and never fail the read`() {
        val decoded = decodePaymentOptions(
            mapOf(
                "zelle" to "on",
                "cash" to mapOf("enabled" to "yes", "instructions" to 42),
                "check" to mapOf("enabled" to true),
                "nonsense" to mapOf("enabled" to true),
            ),
        )
        assertEquals(setOf("cash", "check"), decoded.keys)
        assertEquals(PaymentOptionSetting(null, null), decoded["cash"])
        assertEquals(PaymentOptionSetting(true, null), decoded["check"])
        assertEquals(emptyMap<String, PaymentOptionSetting>(), decodePaymentOptions("not a map"))
    }

    // ── the round trip: what a save from here sends ──────────────────────────

    @Test
    fun `changing only a handle writes only the handle and leaves the web's switches alone`() {
        val draft = paymentDraftOf(loaded).let { it.copy(handles = it.handles + (PaymentHandleField.PAYPAL to "  paypal.me/newname ")) }
        val changes = businessSettingsFieldChanges(loaded, loaded.withPaymentDraft(draft))
        assertEquals(mapOf<String, Any?>("paypalHandle" to "paypal.me/newname"), changes)
    }

    @Test
    fun `flipping one switch keeps every other web-written entry and unknown key verbatim`() {
        val edited = loaded.withPaymentDraft(draftWith(loaded, "klarna") { it.copy(enabled = true) })
        val changes = businessSettingsFieldChanges(loaded, edited)
        assertEquals(setOf("paymentOptions"), changes.keys)

        val written = writtenOptions(changes)
        val original = webWrittenOptions()
        assertEquals(original.keys, written.keys)
        for ((id, entry) in original) {
            if (id == "klarna") continue
            assertEquals("entry $id must round-trip unchanged", entry, written[id])
        }
        assertEquals(mapOf("enabled" to true, "instructions" to ""), written["klarna"])
    }

    @Test
    fun `turning a method off keeps its instructions`() {
        val edited = loaded.withPaymentDraft(draftWith(loaded, "zelle") { it.copy(enabled = false) })
        val written = writtenOptions(businessSettingsFieldChanges(loaded, edited))
        assertEquals(
            mapOf("enabled" to false, "instructions" to "Zelle to the business line, invoice number in the note.", "addedBy" to "web"),
            written["zelle"],
        )
    }

    @Test
    fun `instructions are trimmed on save, the way the web saves them`() {
        val edited = loaded.withPaymentDraft(draftWith(loaded, "other") { PaymentOptionDraft(true, "  Ask me.  ") })
        assertEquals(mapOf("enabled" to true, "instructions" to "Ask me."), writtenOptions(businessSettingsFieldChanges(loaded, edited))["other"])
    }

    /**
     * The web writes an explicit `{ enabled, instructions }` for all eleven
     * methods on every save, so a later change to a default can never rewrite
     * a decision the operator already made. A save from here on a doc that has
     * never had switches sends the same shape.
     */
    @Test
    fun `a switch flipped on a doc with no switches writes every method explicitly, the web's shape`() {
        val bare = BusinessSettings(venmoHandle = "@tribetails")
        val draft = draftWith(bare, "klarna") { it.copy(enabled = true) }
        val changes = businessSettingsFieldChanges(bare, bare.withPaymentDraft(draft))
        assertEquals(setOf("paymentOptions"), changes.keys)
        val written = writtenOptions(changes)
        assertEquals(PAYMENT_METHOD_CATALOGUE.map { it.id }, written.keys.toList())
        for (method in PAYMENT_METHOD_CATALOGUE) {
            val on = if (method.id == "klarna") true else method.defaultEnabled
            assertEquals(mapOf("enabled" to on, "instructions" to ""), written[method.id])
        }
    }
    @Test
    fun `a handle edit on a doc with no switches writes the handle alone`() {
        val bare = BusinessSettings(venmoHandle = "@tribetails")
        val draft = paymentDraftOf(bare).let { it.copy(handles = it.handles + (PaymentHandleField.CASHAPP to "\$tt")) }
        val changes = businessSettingsFieldChanges(bare, bare.withPaymentDraft(draft))
        assertEquals(mapOf<String, Any?>("cashappHandle" to "\$tt"), changes)
    }

    @Test
    fun `another panel's save never names paymentOptions`() {
        val changes = businessSettingsFieldChanges(loaded, loaded.copy(weatherLocation = "Round Rock, TX"))
        assertEquals(setOf("weatherLocation"), changes.keys)
    }

    // ── the catalogue against the server registry ────────────────────────────

    private data class ServerSpec(val id: String, val kind: String, val field: String?, val defaultEnabled: Boolean, val feeBps: Int, val feeFixedCents: Int)

    /** `METHOD_SPECS` rows parsed straight out of the server source, so the mirror cannot drift unseen. */
    private fun serverSpecs(): List<ServerSpec> {
        var dir: File? = File("").absoluteFile
        var source: File? = null
        while (dir != null && source == null) {
            File(dir, "mytribe/functions/src/lib/paymentMethods.ts").takeIf { it.isFile }?.let { source = it }
            dir = dir.parentFile
        }
        val text = (source ?: error("paymentMethods.ts not found above ${File("").absolutePath}")).readText()
        val row = Regex(
            """\{ id: '(\w+)'.*?kind: '(\w+)', field: (null|'(\w+)').*?defaultEnabled: (true|false).*?feeBps: (\d+), feeFixedCents: (\d+) \}""",
        )
        return row.findAll(text).map {
            ServerSpec(
                id = it.groupValues[1],
                kind = it.groupValues[2],
                field = it.groupValues[4].ifEmpty { null },
                defaultEnabled = it.groupValues[5] == "true",
                feeBps = it.groupValues[6].toInt(),
                feeFixedCents = it.groupValues[7].toInt(),
            )
        }.toList()
    }

    @Test
    fun `the catalogue matches the server's METHOD_SPECS row for row`() {
        val server = serverSpecs()
        assertEquals(11, server.size)
        assertEquals(server.map { it.id }, PAYMENT_METHOD_CATALOGUE.map { it.id })
        for ((spec, row) in server.zip(PAYMENT_METHOD_CATALOGUE)) {
            assertEquals(spec.id, spec.kind.uppercase(), row.kind.name)
            assertEquals(spec.id, spec.field, row.handleField?.wireName)
            assertEquals(spec.id, spec.defaultEnabled, row.defaultEnabled)
            if (spec.feeBps == 0 && spec.feeFixedCents == 0) {
                assertEquals(spec.id, null, row.fee)
            } else {
                assertEquals(spec.id, PaymentFee(spec.feeBps, spec.feeFixedCents), row.fee)
            }
        }
    }

    @Test
    fun `instruction methods are exactly the five with no link`() {
        assertEquals(
            listOf("zelle", "banktransfer", "check", "cash", "other"),
            PAYMENT_METHOD_CATALOGUE.filter { it.kind == PaymentMethodKind.INSTRUCTIONS }.map { it.id },
        )
        assertTrue(PAYMENT_METHOD_CATALOGUE.filter { it.kind == PaymentMethodKind.LINK }.all { it.handleField != null })
        assertFalse(PAYMENT_METHOD_CATALOGUE.filter { it.kind != PaymentMethodKind.LINK }.any { it.handleField != null })
    }

    @Test
    fun `fee captions read like the web's`() {
        assertEquals("2.9% + \$0.30", formatFeeSchedule(PaymentFee(290, 30)))
        assertEquals("1.9% + \$0.10", formatFeeSchedule(PaymentFee(190, 10)))
        assertEquals("5.99% + \$0.30", formatFeeSchedule(PaymentFee(599, 30)))
        assertEquals("3.49% + \$0.49", formatFeeSchedule(PaymentFee(349, 49)))
    }
}
