package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * ISSUE #1177: the Payment options editor on the desktop console, away from
 * Compose.
 *
 * The save path under test is the real one: [withPaymentDraft] builds the
 * edited model and [businessSettingsChangedFields] turns it into the map
 * `platformSaveBusinessSettings` PATCHes under an update mask. A masked
 * top-level field REPLACES the stored value, so the written `paymentOptions`
 * has to carry everything the doc held.
 */
class PaymentMethodsTest {

    /** The same `Json` the JVM write path uses (`FirestoreInterop.jvm.kt`, `jsonOut`). */
    private val codec = Json { encodeDefaults = true; ignoreUnknownKeys = true; isLenient = true }

    private fun entry(enabled: Boolean, instructions: String? = null, extra: Map<String, String> = emptyMap()) =
        buildJsonObject {
            put("enabled", enabled)
            if (instructions != null) put("instructions", instructions)
            extra.forEach { (k, v) -> put(k, v) }
        }

    /** A `paymentOptions` map exactly as the web panel writes it, plus keys this console does not model. */
    private val webWritten: JsonObject = buildJsonObject {
        put("stripe", entry(true, ""))
        put("venmo", entry(false, ""))
        put("paypal", entry(true, ""))
        put("cashapp", entry(true, ""))
        put("klarna", entry(false, ""))
        put("affirm", entry(false, ""))
        put("zelle", entry(true, "Zelle to the business line, invoice number in the note.", mapOf("addedBy" to "web")))
        put("banktransfer", entry(false, ""))
        put("check", entry(true, "Payable to the business, handed over at pickup."))
        put("cash", entry(false, "Exact change at pickup."))
        put("other", entry(false, ""))
        put("applepay", entry(true))
    }

    /** Decoded from a document body the way the console reads one, not built by hand. */
    private val loaded: BusinessSettings = codec.decodeFromString(
        BusinessSettings.serializer(),
        buildJsonObject {
            put("businessName", "Tribe Tails")
            put("venmoHandle", "@tribetails")
            put("paypalHandle", "paypal.me/tribetails")
            put("cashappHandle", "\$tribetails")
            put("weatherLocation", "Austin, TX")
            put("paymentOptions", webWritten)
        }.toString(),
    )

    private fun draftWith(settings: BusinessSettings, id: String, change: (PaymentOptionDraft) -> PaymentOptionDraft): PaymentDraft {
        val draft = paymentDraftOf(settings)
        return draft.copy(options = draft.options + (id to change(draft.options.getValue(id))))
    }

    private fun changes(edited: BusinessSettings, from: BusinessSettings = loaded) =
        businessSettingsChangedFields(from, edited, codec)

    // ── reading what the web wrote ───────────────────────────────────────────

    @Test
    fun theEditorOpensOnTheWebsSwitchesAndInstructions() {
        val draft = paymentDraftOf(loaded)
        assertEquals(PAYMENT_METHOD_CATALOGUE.map { it.id }, draft.options.keys.toList())
        assertEquals(PaymentOptionDraft(false, ""), draft.options["venmo"])
        assertEquals(PaymentOptionDraft(true, "Zelle to the business line, invoice number in the note."), draft.options["zelle"])
        assertEquals(PaymentOptionDraft(false, "Exact change at pickup."), draft.options["cash"])
        assertEquals("@tribetails", draft.handles[PaymentHandleField.VENMO])
    }

    @Test
    fun absentIsNotOff_aDocWithNoSwitchesResolvesToEachDefault() {
        val draft = paymentDraftOf(BusinessSettings())
        for (method in PAYMENT_METHOD_CATALOGUE) {
            assertEquals(method.defaultEnabled, draft.options.getValue(method.id).enabled, method.id)
        }
        assertEquals(setOf("stripe", "venmo", "paypal", "cashapp"), draft.options.filterValues { it.enabled }.keys)
    }

    @Test
    fun malformedEntriesReadAsAbsentAndNeverFailTheRead() {
        val doc = """{"businessName":"x","paymentOptions":{"zelle":"on","cash":{"enabled":"true","instructions":42},"check":{"enabled":true}}}"""
        val settings = codec.decodeFromString(BusinessSettings.serializer(), doc)
        val decoded = decodePaymentOptions(settings.paymentOptions)
        assertEquals(setOf("cash", "check"), decoded.keys)
        assertEquals(PaymentOptionSetting(null, null), decoded["cash"])
        assertEquals(PaymentOptionSetting(true, null), decoded["check"])
        val notAMap = codec.decodeFromString(BusinessSettings.serializer(), """{"paymentOptions":"nope"}""")
        assertEquals(emptyMap(), decodePaymentOptions(notAMap.paymentOptions))
    }

    // ── the round trip: what a save from here sends ──────────────────────────

    @Test
    fun changingOnlyAHandleWritesOnlyTheHandle() {
        val draft = paymentDraftOf(loaded).let { it.copy(handles = it.handles + (PaymentHandleField.PAYPAL to "  paypal.me/newname ")) }
        val written = changes(loaded.withPaymentDraft(draft))
        // The web's map is already explicit for all eleven, so rebuilding it on
        // top of itself is byte-identical and is not a change.
        assertEquals(mapOf("paypalHandle" to JsonPrimitive("paypal.me/newname")), written)
    }

    @Test
    fun flippingOneSwitchKeepsEveryOtherEntryAndUnknownKeyVerbatim() {
        val written = changes(loaded.withPaymentDraft(draftWith(loaded, "klarna") { it.copy(enabled = true) }))
        assertEquals(setOf("paymentOptions"), written.keys)
        val options = written.getValue("paymentOptions").jsonObject
        assertEquals(webWritten.keys, options.keys)
        for ((id, value) in webWritten) {
            if (id == "klarna") continue
            assertEquals(value, options[id], "entry $id must round-trip unchanged")
        }
        assertEquals(entry(true, ""), options["klarna"])
    }

    @Test
    fun turningAMethodOffKeepsItsInstructions() {
        val written = changes(loaded.withPaymentDraft(draftWith(loaded, "zelle") { it.copy(enabled = false) }))
        assertEquals(
            entry(false, "Zelle to the business line, invoice number in the note.", mapOf("addedBy" to "web")),
            written.getValue("paymentOptions").jsonObject["zelle"],
        )
    }

    @Test
    fun instructionsAreTrimmedOnSave() {
        val written = changes(loaded.withPaymentDraft(draftWith(loaded, "other") { PaymentOptionDraft(true, "  Ask me.  ") }))
        assertEquals(entry(true, "Ask me."), written.getValue("paymentOptions").jsonObject["other"])
    }

    /** The web writes an explicit `{ enabled, instructions }` for all eleven on every save; so does this. */
    @Test
    fun aSwitchFlippedOnADocWithNoSwitchesWritesEveryMethodExplicitly() {
        val bare = codec.decodeFromString(BusinessSettings.serializer(), """{"venmoHandle":"@tribetails"}""")
        val draft = draftWith(bare, "klarna") { it.copy(enabled = true) }
        val written = changes(bare.withPaymentDraft(draft), from = bare)
        assertEquals(setOf("paymentOptions"), written.keys)
        val options = written.getValue("paymentOptions").jsonObject
        assertEquals(PAYMENT_METHOD_CATALOGUE.map { it.id }, options.keys.toList())
        for (method in PAYMENT_METHOD_CATALOGUE) {
            val on = if (method.id == "klarna") true else method.defaultEnabled
            assertEquals(entry(on, ""), options[method.id], method.id)
        }
    }
    @Test
    fun aHandleEditOnADocWithNoSwitchesWritesTheHandleAlone() {
        val bare = codec.decodeFromString(BusinessSettings.serializer(), """{"venmoHandle":"@tribetails"}""")
        val draft = paymentDraftOf(bare).let { it.copy(handles = it.handles + (PaymentHandleField.CASHAPP to "\$tt")) }
        val written = changes(bare.withPaymentDraft(draft), from = bare)
        assertEquals(setOf("cashappHandle"), written.keys)
    }

    @Test
    fun anotherPanelsSaveNeverNamesPaymentOptions() {
        assertEquals(setOf("weatherLocation"), changes(loaded.copy(weatherLocation = "Round Rock, TX")).keys)
    }

    /**
     * The no-baseline fallback merges every ENCODED key under an update mask.
     * An unloaded `paymentOptions` must not be among them, or the fallback
     * would write null over the web's switches.
     */
    @Test
    fun anUnloadedPaymentOptionsIsNeverEncoded() {
        val encoded = codec.encodeToJsonElement(BusinessSettings.serializer(), BusinessSettings(venmoHandle = "@x")).jsonObject
        assertFalse("paymentOptions" in encoded.keys)
        assertTrue("venmoHandle" in encoded.keys)
        val withOptions = codec.encodeToJsonElement(BusinessSettings.serializer(), loaded).jsonObject
        assertEquals(webWritten, withOptions["paymentOptions"])
    }

    // ── the catalogue against the server registry ────────────────────────────

    private data class ServerSpec(val id: String, val kind: String, val field: String?, val defaultEnabled: Boolean, val feeBps: Int, val feeFixedCents: Int)

    private fun serverSpecs(): List<ServerSpec> {
        val source = generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "mytribe/functions/src/lib/paymentMethods.ts") }
            .firstOrNull { it.isFile }
            ?: error("paymentMethods.ts not found above ${File("").absolutePath}")
        val row = Regex(
            """\{ id: '(\w+)'.*?kind: '(\w+)', field: (null|'(\w+)').*?defaultEnabled: (true|false).*?feeBps: (\d+), feeFixedCents: (\d+) \}""",
        )
        return row.findAll(source.readText()).map {
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
    fun theCatalogueMatchesTheServersMethodSpecsRowForRow() {
        val server = serverSpecs()
        assertEquals(11, server.size)
        assertEquals(server.map { it.id }, PAYMENT_METHOD_CATALOGUE.map { it.id })
        for ((spec, row) in server.zip(PAYMENT_METHOD_CATALOGUE)) {
            assertEquals(spec.kind.uppercase(), row.kind.name, spec.id)
            assertEquals(spec.field, row.handleField?.wireName, spec.id)
            assertEquals(spec.defaultEnabled, row.defaultEnabled, spec.id)
            val fee = if (spec.feeBps == 0 && spec.feeFixedCents == 0) null else PaymentFee(spec.feeBps, spec.feeFixedCents)
            assertEquals(fee, row.fee, spec.id)
        }
    }

    @Test
    fun instructionMethodsAreExactlyTheFiveWithNoLink() {
        assertEquals(
            listOf("zelle", "banktransfer", "check", "cash", "other"),
            PAYMENT_METHOD_CATALOGUE.filter { it.kind == PaymentMethodKind.INSTRUCTIONS }.map { it.id },
        )
        assertTrue(PAYMENT_METHOD_CATALOGUE.filter { it.kind == PaymentMethodKind.LINK }.all { it.handleField != null })
        assertFalse(PAYMENT_METHOD_CATALOGUE.filter { it.kind != PaymentMethodKind.LINK }.any { it.handleField != null })
    }

    @Test
    fun feeCaptionsAndBlankWarningsReadLikeTheWebs() {
        assertEquals("2.9% + \$0.30", formatFeeSchedule(PaymentFee(290, 30)))
        assertEquals("1.9% + \$0.10", formatFeeSchedule(PaymentFee(190, 10)))
        assertEquals("5.99% + \$0.30", formatFeeSchedule(PaymentFee(599, 30)))
        val zelle = PAYMENT_METHOD_CATALOGUE.first { it.id == "zelle" }
        val venmo = PAYMENT_METHOD_CATALOGUE.first { it.id == "venmo" }
        val card = PAYMENT_METHOD_CATALOGUE.first { it.id == "stripe" }
        assertTrue(paymentBlankWarning(zelle, PaymentOptionDraft(true, " "), "")!!.startsWith("Write what kinfolk should do."))
        assertEquals(null, paymentBlankWarning(zelle, PaymentOptionDraft(false, ""), ""))
        assertTrue(paymentBlankWarning(venmo, PaymentOptionDraft(true, ""), "")!!.startsWith("Add your Venmo handle."))
        assertEquals(null, paymentBlankWarning(card, PaymentOptionDraft(true, ""), ""))
    }
}
