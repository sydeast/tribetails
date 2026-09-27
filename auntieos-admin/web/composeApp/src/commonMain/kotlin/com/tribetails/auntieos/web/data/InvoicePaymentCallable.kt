package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlin.math.abs

/**
 * #881: the desktop Record Payment dialog goes through the `recordPayment`
 * callable, in ONE call that carries an `apply`.
 *
 * Before #881 this console wrote the `payments` row directly over REST
 * (`FirestoreClient.recordPayment`, kept, no longer called by the dialog). That
 * row never moved the invoice, never touched the account balance, never wrote
 * an audit entry and never sent a confirmation, so a payment taken here left
 * the invoice open while a payment row said it was paid.
 *
 * WHY ONE CALL WITH `apply`, NOT markInvoicePaid THEN recordPayment. The server
 * stages the invoice apply, the `invoices/{id}/payments` authority row, the
 * account credit, the root `payments` row and the #825 dedupe in one
 * transaction (`recordPayment.ts`), refuses drafts, quotes, cancelled and
 * settled invoices through `planApply`, writes the BILLING_PAYMENT_RECORDED
 * audit entry and sends the confirmation when it is ticked. #988: account credit
 * is only the amount the admin enters, checked by the server against
 * `amount - applied - tip`. One payment, one invoice: `apply` is a single
 * object, never a list.
 */
data class InvoicePaymentEntry(
    /** The display row. `amount` is the WHOLE sum the client paid, gross tip included. */
    val payment: Payment,
    /** Dollars of [Payment.amount] applied to this invoice. */
    val applyAmount: Double,
    /** The processor's cut. Stored beside the gross tip; never subtracted from it. */
    val fee: Double,
    /**
     * #988: the account credit the admin chose to leave, in integer cents, out of
     * what would otherwise be tip. The server credits exactly this. `autoApply`
     * goes on the wire as `creditToAccountCents > 0`.
     */
    val creditToAccountCents: Long,
    /** Send the household the `invoice.payment.applied` confirmation. */
    val sendConfirmationEmail: Boolean,
)

/**
 * The `recordPayment` request for [entry]. Pure, so the payload is a unit test.
 *
 * [kinfolkId] is passed in already scoped for test mode; the server re-scopes a
 * sandbox caller anyway. [idempotencyKey] is left out, not sent as null, when
 * absent: the callable's zod guard refuses an explicit null.
 */
fun recordPaymentPayload(entry: InvoicePaymentEntry, kinfolkId: String, idempotencyKey: String?): JsonObject {
    val p = entry.payment
    return buildJsonObject {
        put("kinfolkId", kinfolkId)
        put("kinfolkName", p.kinfolkName)
        put("client", p.client)
        put("date", p.date)
        put("paymentMethod", p.paymentMethod)
        put("referenceNumber", p.referenceNumber)
        put("amount", p.amount)
        put("tip", p.tip)
        put("fee", entry.fee)
        put("notes", p.notes)
        put("invoiceId", p.invoiceId)
        put("invoiceNumber", p.invoiceNumber)
        put("apply", buildJsonObject {
            put("invoiceId", p.invoiceId)
            put("invoiceNumber", p.invoiceNumber)
            put("amount", entry.applyAmount)
        })
        // #988: the credit is the amount she entered; `autoApply` only says there is one.
        put("autoApply", entry.creditToAccountCents > 0L)
        put("creditToAccountCents", entry.creditToAccountCents)
        put("sendConfirmationEmail", entry.sendConfirmationEmail)
        idempotencyKey?.let { put("idempotencyKey", JsonPrimitive(it)) }
    }
}

/** What `recordPayment` answered. Only the fields the dialog reports. */
data class RecordPaymentOutcome(
    val paymentId: String,
    /** `application.state`: unpaid, partial, settled, overpaid, or blank when the server sent none. */
    val invoiceState: String,
    val amountDueCents: Long,
    val overpaidCents: Long,
    val creditedToAccountCents: Long,
    val confirmationEmailSent: Boolean,
    val householdNoPortalAccount: Boolean,
    val officeNoticePending: Boolean,
)

private val recordPaymentJson = Json { ignoreUnknownKeys = true; isLenient = true }

/** Decodes the callable's answer. Throws on a body with no `paymentId`: a payment the server did not name is not a recorded payment. */
fun decodeRecordPaymentOutcome(body: String): RecordPaymentOutcome {
    val obj = recordPaymentJson.parseToJsonElement(body).jsonObject
    val paymentId = obj["paymentId"]?.jsonPrimitive?.contentOrNull.orEmpty()
    require(paymentId.isNotBlank()) { "recordPayment answered without a paymentId" }
    val app = (obj["application"] as? JsonObject)
    fun JsonObject?.cents(key: String) = this?.get(key)?.jsonPrimitive?.longOrNull ?: 0L
    fun flag(key: String) = obj[key]?.jsonPrimitive?.booleanOrNull == true
    return RecordPaymentOutcome(
        paymentId = paymentId,
        invoiceState = app?.get("state")?.jsonPrimitive?.contentOrNull.orEmpty(),
        amountDueCents = app.cents("amountDueCents"),
        overpaidCents = app.cents("overpaidCents"),
        creditedToAccountCents = obj.cents("creditedToAccountCents"),
        confirmationEmailSent = flag("confirmationEmailSent"),
        householdNoPortalAccount = flag("householdNoPortalAccount"),
        officeNoticePending = flag("officeNoticePending"),
    )
}

private fun centsUsd(cents: Long): String {
    val sign = if (cents < 0) "-" else ""
    val a = abs(cents)
    return sign + "$" + (a / 100).toString() + "." + (a % 100).toString().padStart(2, '0')
}

/**
 * The sentence the operator reads after the call answers. It says what the
 * SERVER decided (partial, settled, overpaid), then the #866 confirmation
 * outcome, then where any leftover went. Same wording rules as Android's
 * `recordPaymentToast` and `recordPaymentConfirmationNote`.
 */
fun recordPaymentOutcomeMessage(outcome: RecordPaymentOutcome, confirmationRequested: Boolean): String {
    val head = when (outcome.invoiceState) {
        "partial" ->
            "Partial payment recorded. ${centsUsd(outcome.amountDueCents)} is still owed, and the invoice stays open."
        "overpaid" ->
            "Payment recorded and the invoice is settled. It was overpaid by ${centsUsd(outcome.overpaidCents)}."
        "settled" -> "Payment recorded. The invoice is paid in full."
        else -> "Payment recorded. The server did not report where the invoice now stands, so open it to check what is still owed."
    }
    val household = when {
        !confirmationRequested || outcome.confirmationEmailSent -> ""
        outcome.householdNoPortalAccount ->
            " The confirmation email did not go out: the household has no portal account."
        else -> " The confirmation email did not go out. Let the household know another way."
    }
    val office = if (outcome.officeNoticePending) {
        " The office copy of the payment notice did not go out, because the admin roster could not be read. The household copy is not affected."
    } else ""
    val credit = if (outcome.creditedToAccountCents > 0) {
        " ${centsUsd(outcome.creditedToAccountCents)} has been added to the household's account balance for their next invoice."
    } else ""
    return head + household + office + credit
}

/**
 * What the dialog shows when the call is refused or fails. The server's own
 * message goes through verbatim: it names the reason (a draft, a settled
 * invoice, an apply larger than the payment) better than any paraphrase here.
 */
fun recordPaymentRefusalText(serverMessage: String): String = "Couldn't record payment: $serverMessage"
/**
 * #825 and #881: ONE KEY PER SUBMISSION, NOT PER PRESS.
 *
 * A failed or lost attempt leaves the dialog open with every field filled in,
 * so the next press is a retry of the same payment and must carry the same key;
 * the server then answers it from the first attempt's row instead of recording
 * the money twice. A changed entry is a different payment and gets a new key.
 * [release] after the server has answered Ok, so a second, genuinely identical
 * payment (two equal cash instalments on one day) is not replayed as the first.
 */
class PaymentSubmissionKeys(private val mint: () -> String = { mintPaymentIdempotencyKey() }) {
    private var held: Pair<String, String>? = null

    fun keyFor(signature: String): String {
        held?.let { (sig, key) -> if (sig == signature) return key }
        val minted = mint()
        held = signature to minted
        return minted
    }

    fun release() {
        held = null
    }
}

/**
 * The dialog's submit, outside Compose so it is testable: take the held key for
 * this entry, call the callable, release the key only on Ok. On Err the key is
 * kept, so a re-press of the same entry sends the same key.
 */
suspend fun submitInvoicePayment(
    client: FirestoreClient,
    entry: InvoicePaymentEntry,
    keys: PaymentSubmissionKeys,
): WriteResult<RecordPaymentOutcome> {
    // A data class's toString names every field, so a field added later cannot
    // fall out of the comparison.
    val key = keys.keyFor(entry.toString())
    val r = client.recordInvoicePayment(entry, idempotencyKey = key)
    if (r is WriteResult.Ok) keys.release()
    return r
}
