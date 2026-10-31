package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * ISSUE #1177: the payment options catalogue, one row per method the operator
 * can switch on, mirrored from the server registry
 * (`mytribe/functions/src/lib/paymentMethods.ts`, `METHOD_SPECS`) and the
 * React admin's copy of it (`auntieos-admin/src/api/settings.ts`,
 * `PAYMENT_METHOD_CATALOGUE`).
 *
 * Mirrored rather than imported because nothing here can import TypeScript.
 * `PaymentMethodsTest` reads `paymentMethods.ts` off disk and fails if the ids,
 * order, kinds, defaults or handle fields ever drift.
 *
 * WHERE IT LIVES ON THE DOCUMENT. Two places, exactly as the web writes them:
 *  - the three handles keep their own top-level fields (`venmoHandle` and
 *    friends), which the invoice PDF and the portal still read;
 *  - `paymentOptions` is a map keyed by method id, each entry
 *    `{ enabled, instructions }`. SPARSE: a method with no entry, or an entry
 *    with no `enabled`, resolves to its `defaultEnabled`. Only an explicit
 *    `false` turns a method off.
 *
 * `kind` decides what the settings row shows:
 *   CHECKOUT      a switch and nothing else (card, Klarna, Affirm ride Stripe)
 *   LINK          a switch and a handle box
 *   INSTRUCTIONS  a switch and a "What kinfolk should do" box
 */
enum class PaymentMethodKind { CHECKOUT, LINK, INSTRUCTIONS }

/** The `BusinessSettings` top-level field a LINK method keeps its handle in. */
enum class PaymentHandleField(val wireName: String, val placeholder: String) {
    VENMO("venmoHandle", "@tribetails"),
    PAYPAL("paypalHandle", "paypal.me/tribetails"),
    CASHAPP("cashappHandle", "\$tribetails"),
}

/** Fee schedule, admin-only display. Basis points and integer cents, never a float percentage. */
data class PaymentFee(val feeBps: Int, val feeFixedCents: Int)

data class PaymentMethodRow(
    /** The `paymentOptions` key, and the server's `PayMethodId`. */
    val id: String,
    /** The row heading: "Venmo", not "Pay with Venmo". */
    val label: String,
    val kind: PaymentMethodKind,
    /** What a method with no saved switch resolves to. True only for the four that predate the switches. */
    val defaultEnabled: Boolean,
    val handleField: PaymentHandleField? = null,
    val instructionsPlaceholder: String = "",
    val fee: PaymentFee? = null,
    val note: String? = null,
)

/** In the order a household sees them, same as the server. */
val PAYMENT_METHOD_CATALOGUE: List<PaymentMethodRow> = listOf(
    PaymentMethodRow(
        id = "stripe", label = "Credit card", kind = PaymentMethodKind.CHECKOUT, defaultEnabled = true,
        fee = PaymentFee(290, 30),
        note = "Runs through Stripe. Kinfolk pay from the invoice and the balance clears itself.",
    ),
    PaymentMethodRow(
        id = "venmo", label = "Venmo", kind = PaymentMethodKind.LINK, defaultEnabled = true,
        handleField = PaymentHandleField.VENMO, fee = PaymentFee(190, 10),
    ),
    PaymentMethodRow(
        id = "paypal", label = "PayPal", kind = PaymentMethodKind.LINK, defaultEnabled = true,
        handleField = PaymentHandleField.PAYPAL, fee = PaymentFee(349, 49),
    ),
    PaymentMethodRow(
        id = "cashapp", label = "Cash App", kind = PaymentMethodKind.LINK, defaultEnabled = true,
        handleField = PaymentHandleField.CASHAPP, fee = PaymentFee(260, 15),
    ),
    PaymentMethodRow(
        id = "klarna", label = "Klarna", kind = PaymentMethodKind.CHECKOUT, defaultEnabled = false,
        fee = PaymentFee(599, 30),
        note = "Rides your Stripe account. Activate Klarna in Stripe first, or checkout falls back to card.",
    ),
    PaymentMethodRow(
        id = "affirm", label = "Affirm", kind = PaymentMethodKind.CHECKOUT, defaultEnabled = false,
        fee = PaymentFee(599, 30),
        note = "Rides your Stripe account. Activate Affirm in Stripe first, or checkout falls back to card.",
    ),
    PaymentMethodRow(
        id = "zelle", label = "Zelle", kind = PaymentMethodKind.INSTRUCTIONS, defaultEnabled = false,
        instructionsPlaceholder = "Zelle to (555) 555-0104, and put the invoice number in the note.",
    ),
    PaymentMethodRow(
        id = "banktransfer", label = "Bank transfer", kind = PaymentMethodKind.INSTRUCTIONS, defaultEnabled = false,
        instructionsPlaceholder = "Routing 000000000, account 000000000, Tribe Tails Care.",
    ),
    PaymentMethodRow(
        id = "check", label = "Check", kind = PaymentMethodKind.INSTRUCTIONS, defaultEnabled = false,
        instructionsPlaceholder = "Make it out to Tribe Tails Care and hand it over at pickup.",
    ),
    PaymentMethodRow(
        id = "cash", label = "Cash", kind = PaymentMethodKind.INSTRUCTIONS, defaultEnabled = false,
        instructionsPlaceholder = "Exact change, handed to your Auntie at pickup.",
    ),
    PaymentMethodRow(
        id = "other", label = "Other", kind = PaymentMethodKind.INSTRUCTIONS, defaultEnabled = false,
        instructionsPlaceholder = "Anything else you take, in your own words.",
    ),
)

/**
 * Mirrors `MAX_INSTRUCTIONS_LENGTH` on the server, which REFUSES longer
 * instructions (it never truncates payment details), so the method would
 * silently drop off invoices. The box stops the operator here instead.
 */
const val MAX_PAYMENT_INSTRUCTIONS_LENGTH = 500

/** One method's saved configuration, exactly as stored: either half may be absent. */
data class PaymentOptionSetting(val enabled: Boolean? = null, val instructions: String? = null)

/** One method as the editor shows it: absent resolved to the default, blank instructions as "". */
data class PaymentOptionDraft(val enabled: Boolean, val instructions: String)

/** Everything the Payment options panel edits. */
data class PaymentDraft(
    val options: Map<String, PaymentOptionDraft>,
    val handles: Map<PaymentHandleField, String>,
) {
    /** Trimmed, the form a save writes and a dirty check compares. */
    fun normalized(): PaymentDraft = PaymentDraft(
        options = options.mapValues { (_, o) -> o.copy(instructions = o.instructions.trim()) },
        handles = handles.mapValues { (_, h) -> h.trim() },
    )
}

/**
 * Reads the stored `paymentOptions` map, keeping only catalogue ids and only
 * well-typed values. Same drop rules as the web `mergePaymentOptions` and the
 * server `payMethodSettingsFrom`.
 */
fun decodePaymentOptions(raw: JsonElement?): Map<String, PaymentOptionSetting> {
    val rows = raw as? JsonObject ?: return emptyMap()
    val out = LinkedHashMap<String, PaymentOptionSetting>()
    for (method in PAYMENT_METHOD_CATALOGUE) {
        val entry = rows[method.id] as? JsonObject ?: continue
        val enabled = (entry["enabled"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
        val instructions = (entry["instructions"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        out[method.id] = PaymentOptionSetting(enabled, instructions)
    }
    return out
}

fun BusinessSettings.paymentHandle(field: PaymentHandleField): String = when (field) {
    PaymentHandleField.VENMO -> venmoHandle
    PaymentHandleField.PAYPAL -> paypalHandle
    PaymentHandleField.CASHAPP -> cashappHandle
}

/** Is this method offered? Absent is not off. */
fun isPaymentMethodEnabled(options: Map<String, PaymentOptionSetting>, method: PaymentMethodRow): Boolean =
    options[method.id]?.enabled ?: method.defaultEnabled

/** The editor's starting point for [settings]: every method, every handle. */
fun paymentDraftOf(settings: BusinessSettings): PaymentDraft {
    val stored = decodePaymentOptions(settings.paymentOptions)
    return PaymentDraft(
        options = PAYMENT_METHOD_CATALOGUE.associate { method ->
            method.id to PaymentOptionDraft(
                enabled = isPaymentMethodEnabled(stored, method),
                instructions = stored[method.id]?.instructions.orEmpty(),
            )
        },
        handles = PaymentHandleField.entries.associateWith { settings.paymentHandle(it) },
    )
}

/**
 * [this] with [draft] applied: the three handles trimmed into their own fields,
 * and `paymentOptions` carrying an explicit `{ enabled, instructions }` for
 * EVERY catalogue method, which is the shape the web panel writes.
 *
 * Built ON TOP of the stored map, not in place of it, and that matters more
 * here than on the web: this console writes a changed top-level field under an
 * update mask, which REPLACES the stored `paymentOptions` map whole rather than
 * merging it key by key. So every key the console does not model (an id from a
 * newer build, an extra field on an entry) has to be in the payload, or the
 * save would delete it.
 *
 * A save whose switches and instructions all match what is stored (a handle
 * edit, say) leaves `paymentOptions` exactly as it was read, so the write is
 * the handle alone and cannot revert a switch the web changed since this
 * client loaded.
 */
fun BusinessSettings.withPaymentDraft(draft: PaymentDraft): BusinessSettings {
    val clean = draft.normalized()
    val handlesApplied = copy(
        venmoHandle = clean.handles[PaymentHandleField.VENMO] ?: venmoHandle,
        paypalHandle = clean.handles[PaymentHandleField.PAYPAL] ?: paypalHandle,
        cashappHandle = clean.handles[PaymentHandleField.CASHAPP] ?: cashappHandle,
    )
    if (clean.options == paymentDraftOf(this).normalized().options) return handlesApplied
    val stored = paymentOptions as? JsonObject ?: JsonObject(emptyMap())
    val merged = LinkedHashMap<String, JsonElement>(stored)
    for (method in PAYMENT_METHOD_CATALOGUE) {
        val entry = LinkedHashMap<String, JsonElement>(stored[method.id] as? JsonObject ?: JsonObject(emptyMap()))
        val option = clean.options[method.id]
        entry["enabled"] = JsonPrimitive(option?.enabled ?: method.defaultEnabled)
        entry["instructions"] = JsonPrimitive(option?.instructions.orEmpty())
        merged[method.id] = JsonObject(entry)
    }
    return handlesApplied.copy(paymentOptions = JsonObject(merged))
}

/** "2.9% + $0.30". Display only; never a recorded fee. */
fun formatFeeSchedule(fee: PaymentFee): String {
    val whole = fee.feeBps / 100
    val frac = (fee.feeBps % 100).toString().padStart(2, '0').trimEnd('0')
    val pct = if (frac.isEmpty()) "$whole" else "$whole.$frac"
    val dollars = fee.feeFixedCents / 100
    val cents = (fee.feeFixedCents % 100).toString().padStart(2, '0')
    return "$pct% + \$$dollars.$cents"
}

/** The note and fee line under a method's name, as the web shows them. Null when a method has neither. */
fun paymentRowCaption(method: PaymentMethodRow): String? {
    val fee = method.fee?.let { "${method.label} charges about ${formatFeeSchedule(it)} per payment." }
    return listOfNotNull(method.note, fee).joinToString(" ").ifBlank { null }
}

/**
 * The warning under a method that is on but has nothing typed. The portal
 * omits a method it cannot render rather than showing a dead button, so
 * without this the operator turns Zelle on, types nothing, and sees no sign
 * that it never reached an invoice. Same words as the web.
 */
fun paymentBlankWarning(method: PaymentMethodRow, option: PaymentOptionDraft, handle: String): String? {
    if (!option.enabled) return null
    return when (method.kind) {
        PaymentMethodKind.LINK -> if (handle.isBlank()) {
            "Add your ${method.label} handle. Until then this stays off invoices, because a button with no handle behind it opens nothing."
        } else null
        PaymentMethodKind.INSTRUCTIONS -> if (option.instructions.isBlank()) {
            "Write what kinfolk should do. Until then this stays off invoices, because a heading with nothing under it tells them nothing."
        } else null
        PaymentMethodKind.CHECKOUT -> null
    }
}

// ── ISSUE #1200: the invoice "How to pay" panel ─────────────────────────────

/**
 * The payment settings one invoice is resolved against, in the shape the
 * resolver below reads: the three handles and the decoded switches.
 */
data class InvoicePaySettings(
    val handles: Map<PaymentHandleField, String>,
    val options: Map<String, PaymentOptionSetting>,
)

/**
 * One row of the "How to pay" panel. [label] is the catalogue name ("Venmo",
 * "Zelle"), [detail] is what the household is told: the handle, the
 * operator's instructions, or that a checkout method is paid in the portal.
 */
data class HowToPayRow(val methodId: String, val label: String, val detail: String)

/** What a card, Klarna or Affirm row says. They are a checkout button on the portal invoice, nothing to copy down. */
const val HOW_TO_PAY_CHECKOUT_DETAIL = "In the portal"

/** A handle the server will not turn into a link: `paypal.me/` cannot resolve an email. */
private val HOW_TO_PAY_EMAIL = Regex("""^[^\s@]+@[^\s@]+\.[^\s@]+$""")

/**
 * The settings [invoice] is offered under, the way the server's
 * `settingsForInvoice` decides it: the snapshot the invoice was issued with
 * when it carries one, the live [settings] when it does not, or when the
 * snapshot is not an object (hand-edited, half-written). Same read as
 * `payMethodSettingsFrom`: a non-string handle reads as absent, and
 * instructions longer than [MAX_PAYMENT_INSTRUCTIONS_LENGTH] are dropped,
 * because the server refuses them rather than truncate payment details.
 */
fun invoicePaySettingsOf(invoice: Invoice, settings: BusinessSettings?): InvoicePaySettings {
    val snapshot = invoice.payMethodSettingsSnapshot as? JsonObject
    val handles: Map<PaymentHandleField, String>
    val options: Map<String, PaymentOptionSetting>
    if (snapshot != null) {
        handles = PaymentHandleField.entries.associateWith { field ->
            (snapshot[field.wireName] as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty()
        }
        options = decodePaymentOptions(snapshot["paymentOptions"])
    } else {
        handles = PaymentHandleField.entries.associateWith { settings?.paymentHandle(it).orEmpty() }
        options = decodePaymentOptions(settings?.paymentOptions)
    }
    return InvoicePaySettings(
        handles = handles,
        options = options.mapValues { (_, o) ->
            o.copy(instructions = o.instructions?.takeIf { it.length <= MAX_PAYMENT_INSTRUCTIONS_LENGTH })
        },
    )
}

/**
 * Would the server build a working link from [raw]? Mirrors
 * `normalizeHandle`: blank is no, a URL is yes, an email is no (the server
 * omits it rather than glue it onto `paypal.me/`), and a handle that is only
 * the stripped `@` is no. Cash App keeps its `$`, so nothing is stripped there.
 */
private fun howToPayHandleResolves(raw: String, field: PaymentHandleField): Boolean {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return false
    if (trimmed.startsWith("http://", ignoreCase = true) || trimmed.startsWith("https://", ignoreCase = true)) return true
    if (HOW_TO_PAY_EMAIL.matches(trimmed)) return false
    val rest = if (field != PaymentHandleField.CASHAPP) trimmed.removePrefix("@") else trimmed
    return rest.isNotEmpty()
}

/**
 * Stored states that owe nothing. The portal offers no way to pay on these
 * (`resolvePayMethods` answers `[]` for nothing owed, a paid invoice offers
 * nothing per the 2026-09-27 ruling, and a cancelled one is in no portal
 * bucket), so neither does this panel. Read off the stored `status` stamp.
 */
private val HOW_TO_PAY_SETTLED_STATES = setOf("paid", "zero", "credit", "redeemed", "cancelled")

/**
 * The "How to pay" rows for [invoice], resolved the way the server resolves
 * what the household is offered (`resolvePayMethods`): the switch first, then
 * the handle or the instructions, against the invoice's own snapshot before
 * live [settings], in the portal's order. A method that is off, or on with
 * nothing behind it, is left out, exactly as the portal leaves it out.
 */
fun howToPayRowsForInvoice(invoice: Invoice, settings: BusinessSettings?): List<HowToPayRow> {
    if (invoice.status.trim().lowercase() in HOW_TO_PAY_SETTLED_STATES) return emptyList()
    val resolved = invoicePaySettingsOf(invoice, settings)
    return PAYMENT_METHOD_CATALOGUE.mapNotNull { method ->
        if (!isPaymentMethodEnabled(resolved.options, method)) return@mapNotNull null
        val detail = when (method.kind) {
            PaymentMethodKind.CHECKOUT -> HOW_TO_PAY_CHECKOUT_DETAIL
            PaymentMethodKind.INSTRUCTIONS -> resolved.options[method.id]?.instructions?.trim()?.takeIf { it.isNotEmpty() }
            PaymentMethodKind.LINK -> method.handleField?.let { field ->
                resolved.handles[field].orEmpty().trim().takeIf { howToPayHandleResolves(it, field) }
            }
        } ?: return@mapNotNull null
        HowToPayRow(method.id, method.label, detail)
    }
}
