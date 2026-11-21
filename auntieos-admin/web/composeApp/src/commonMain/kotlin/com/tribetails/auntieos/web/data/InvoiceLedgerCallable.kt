package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * #2333: THE INVOICE PAYMENTS LIST, IN CENTS THE SERVER RESOLVED.
 *
 * The desktop invoice screen used to read the root `payments` collection
 * itself and print `amount + tip` as dollars. Both halves were wrong:
 *
 * - `stripeWebhook.ts` writes a card payment's `amount` in CENTS when the figure
 *   came off the Stripe event (told apart only by `amountSource`), so a $42.00
 *   card payment printed as $4,200.00.
 * - A hand-recorded payment's `amount` is the whole sum the client paid, the
 *   GROSS tip already inside it, so adding `tip` counted the gratuity twice.
 *
 * Admin web (`InvoiceLedger.tsx`) and admin Android (`InvoiceDetailViewModel`)
 * both ask `getInvoiceLedger`, which resolves the units once with
 * `resolveLedgerAmountCents` (`mytribe/functions/src/lib/paymentMoney.ts`) and
 * answers in integer cents. This console now asks the same callable, so the
 * three clients cannot disagree about what a row is worth. The units rule is
 * NOT copied into Kotlin.
 *
 * Hand-written from `mytribe/functions/src/admin/getInvoiceLedger.ts`
 * (`LedgerPaymentSchema`), the way the other callables in this package are;
 * only the fields the Payments panel draws are decoded and unknown keys are
 * ignored.
 */

/** One root `payments` row, as `getInvoiceLedger` answers it. */
data class InvoiceLedgerPayment(
    val paymentId: String,
    /** The whole sum collected, the GROSS tip inside it. Never add [tipCents] to it. */
    val amountCents: Long,
    /**
     * False when the server could not honestly read the row's amount. [amountCents]
     * is then the schema's floor of 0, not a claim that nothing was collected,
     * so it is never printed. A missing key reads as false.
     */
    val amountResolved: Boolean,
    /** The gross tip, already inside [amountCents]. */
    val tipCents: Long,
    /** The processor's cut, which comes out of the tip. */
    val feeCents: Long,
    val tipBasis: String,
    val appliedCents: Long,
    val method: String,
    val reference: String,
    /** Free text on this collection, like every legacy billing date. */
    val date: String,
    /**
     * Can `amount = applied + tipGross + unapplied` be checked? False on an
     * unknown-basis tip. A missing key reads as false.
     */
    val reconciles: Boolean,
    /** Amount less applied less the gross tip. SIGNED, never clamped. */
    val unappliedCents: Long,
    /** A leftover goes to the household's account credit. */
    val autoApply: Boolean,
    /** Which invoice the payment was applied to; blank when it touched no balance. */
    val appliedInvoiceId: String,
    val appliedInvoiceNumber: String,
    /**
     * #2334: the Method cell in the server's plain words (Card, Klarna, Affirm,
     * "Online payment" for an old checkout payment). Blank from a server older
     * than the field; [ledgerRowMethodLabel] then reads [method] itself.
     */
    val methodLabel: String = "",
)

/** The two payment lists the Payments panel draws. */
data class InvoiceLedgerPayments(
    /** Rows naming this invoice. */
    val linked: List<InvoiceLedgerPayment>,
    /** Rows for the same household that name no invoice at all. */
    val unlinkedKinfolk: List<InvoiceLedgerPayment>,
)

private val ledgerJson = Json { ignoreUnknownKeys = true; isLenient = true }

private fun JsonObject.s(key: String): String = (this[key] as? JsonPrimitive)?.contentOrNull.orEmpty()
private fun JsonObject.l(key: String): Long = (this[key] as? JsonPrimitive)?.longOrNull ?: 0L
private fun JsonObject.b(key: String): Boolean = (this[key] as? JsonPrimitive)?.booleanOrNull == true
private fun JsonObject.objs(key: String): List<JsonObject> =
    (this[key] as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()

/** The `getInvoiceLedger` request. */
fun invoiceLedgerPayload(invoiceId: String): JsonObject =
    buildJsonObject { put("invoiceId", invoiceId) }

private fun JsonObject.toLedgerPayment(): InvoiceLedgerPayment = InvoiceLedgerPayment(
    paymentId = s("paymentId"),
    amountCents = l("amountCents"),
    amountResolved = b("amountResolved"),
    tipCents = l("tipCents"),
    feeCents = l("feeCents"),
    tipBasis = s("tipBasis"),
    appliedCents = l("appliedCents"),
    method = s("method"),
    methodLabel = s("methodLabel"),
    reference = s("reference"),
    date = s("date"),
    // Absent reads as false, like amountResolved: a row is not claimed to balance unchecked.
    reconciles = b("reconciles"),
    unappliedCents = l("unappliedCents"), // signed: a negative stays negative
    autoApply = b("autoApply"),
    appliedInvoiceId = s("appliedInvoiceId"),
    appliedInvoiceNumber = s("appliedInvoiceNumber"),
)

/** Decodes the payment lists of a `getInvoiceLedger` answer. Missing lists read as empty. */
fun decodeInvoiceLedgerPayments(body: String): InvoiceLedgerPayments {
    val obj = ledgerJson.parseToJsonElement(body).jsonObject
    return InvoiceLedgerPayments(
        linked = obj.objs("ledgerPayments").map { it.toLedgerPayment() }.filter { it.paymentId.isNotBlank() },
        unlinkedKinfolk = obj.objs("unlinkedKinfolkPayments").map { it.toLedgerPayment() }
            .filter { it.paymentId.isNotBlank() },
    )
}

/** What a payments row prints for its amount: the server's cents, or that it could not be read. */
const val LEDGER_AMOUNT_UNREAD = "could not be read"

fun ledgerPaymentAmountLabel(p: InvoiceLedgerPayment): String =
    if (p.amountResolved) com.tribetails.auntieos.web.util.formatUsdCents(p.amountCents) else LEDGER_AMOUNT_UNREAD

// ── #2391 and #2390: what one Payments row says, the same words as Android ──
// (`domain/InvoiceLedgerRow.kt`) and admin web (`InvoiceLedger.tsx`). Every
// figure comes from the server; nothing here works money out.

private fun usd(cents: Long): String = com.tribetails.auntieos.web.util.formatUsdCents(cents)

/** #2334: what a checkout payment with no stored method reads as, the server's own words. */
const val ONLINE_PAYMENT_LABEL = "Online payment"

/**
 * The method in plain words, or a plain stand-in when none was recorded.
 *
 * #2334: the server's words win (Card, Klarna, Affirm). A server older than the
 * field sends none, and the stored word for a checkout payment, `stripe`, is
 * never shown: it reads "Online payment". The same words as Android's
 * `paymentMethodLabel` and the web's.
 */
fun ledgerRowMethodLabel(p: InvoiceLedgerPayment): String {
    val label = p.methodLabel.trim()
    if (label.isNotEmpty()) return label
    val stored = p.method.trim()
    if (stored.equals("stripe", ignoreCase = true)) return ONLINE_PAYMENT_LABEL
    return stored.ifEmpty { "no method recorded" }
}

private val LEDGER_MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/**
 * #2390: the row's date, WHOLE. The field is free text: a hand-recorded
 * payment holds what was typed ("February 17, 2026"), which this console used
 * to cut to ten characters ("February 1").
 *
 * A stored ISO day reads in the medium style, "Oct 12, 2026". It counts as one
 * only when the text is the day alone or the day is followed by `T` or a space
 * (a time), the rule Android's `formatJoinDate` uses. Anything else is shown
 * exactly as stored, never cut: "2026-10-12th" stays as written.
 */
fun ledgerRowDateLabel(p: InvoiceLedgerPayment): String {
    val raw = p.date.trim()
    if (raw.isEmpty()) return "no date recorded"
    if (raw.length > 10 && raw[10] != 'T' && raw[10] != ' ') return raw
    val day = com.tribetails.auntieos.web.screens.directory.isoDayOrNull(raw.take(10)) ?: return raw
    return "${LEDGER_MONTHS[day.month.ordinal]} ${day.day}, ${day.year}"
}

/**
 * #2417, #2420: how an invoice that has no number is named wherever its number
 * would stand. Never its stored id. The same words ship on admin web and
 * Android.
 */
const val INVOICE_WITH_NO_NUMBER = "an invoice with no number"

/** The same, where it opens a line. */
const val INVOICE_WITH_NO_NUMBER_LEAD = "Invoice with no number"

/**
 * The invoice the money went to ("#1029"), the words for an invoice that has no
 * number, or "" when the payment touched no balance.
 */
fun ledgerRowAppliedTo(p: InvoiceLedgerPayment): String {
    val number = p.appliedInvoiceNumber.trim()
    if (number.isNotEmpty()) return "#$number"
    if (p.appliedInvoiceId.trim().isNotEmpty()) return INVOICE_WITH_NO_NUMBER
    return ""
}

/** Never "$0.00 applied": a payment that touched no balance says so. */
fun ledgerRowAppliedLabel(p: InvoiceLedgerPayment): String =
    if (ledgerRowAppliedTo(p).isEmpty()) "not applied" else usd(p.appliedCents)

/** The stored tip is the GROSS, already inside the amount. */
fun ledgerRowTipLabel(p: InvoiceLedgerPayment): String = usd(p.tipCents)

/** "gross" beside a gross tip, the tax-relevant fact; nothing on a zero or unknown-basis tip. */
fun ledgerRowTipNote(p: InvoiceLedgerPayment): String? =
    if (p.tipCents > 0L && p.tipBasis == "gross") "gross" else null

/** The fee, which comes out of the tip. "not recorded" on a migrated row whose fee was dropped. */
fun ledgerRowFeeLabel(p: InvoiceLedgerPayment): String = when {
    p.feeCents > 0L -> usd(p.feeCents)
    p.reconciles -> usd(0L)
    else -> "not recorded"
}

/**
 * What is left on the payment. Not a figure when the amount could not be read:
 * the server worked it out from that amount, so on such a row it is arithmetic
 * over a floor of 0 and can come out negative without anything being over-applied.
 */
fun ledgerRowBalanceLabel(p: InvoiceLedgerPayment): String =
    if (p.amountResolved) usd(p.unappliedCents) else LEDGER_AMOUNT_UNREAD

/** Where a leftover went, when it went to account credit. */
fun ledgerRowBalanceNote(p: InvoiceLedgerPayment): String? =
    if (p.amountResolved && p.unappliedCents > 0L && p.autoApply) "held as credit" else null

/**
 * Why a row cannot be reconciled, or "". Same sentences and the same order as
 * Android: the unread amount is tested first, because such a row can also carry
 * a negative balance and "more was applied" would be the wrong thing to say.
 */
fun ledgerRowCaveat(p: InvoiceLedgerPayment): String = when {
    !p.amountResolved ->
        "The amount on this row could not be read: either no figure was ever resolved for the " +
            "payment, or what was stored is not a usable number. Nothing is shown in its place, " +
            "and the balance is left blank too, because it was worked out from that same figure."
    !p.reconciles ->
        "This row was migrated without its processor fee, so whether the tip shown is before or " +
            "after that fee was never recorded. It cannot be reconciled, and no gross tip has " +
            "been guessed for it."
    p.unappliedCents < 0L ->
        "More was applied to invoices than this payment covers, so this row does not balance."
    else -> ""
}

/** Every caveat the rows carry, said once each, in the order they first appear. */
fun ledgerCaveats(rows: List<InvoiceLedgerPayment>): List<String> =
    rows.map { ledgerRowCaveat(it) }.filter { it.isNotEmpty() }.distinct()
