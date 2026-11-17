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
    reference = s("reference"),
    date = s("date"),
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
