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
    /**
     * #1511: the household's confirmation reached them in the app only, with
     * every delivery channel off for them; `confirmationEmailSent` is then
     * false. Absent from an older function, which reads false.
     */
    val confirmationAppOnly: Boolean = false,
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
        confirmationAppOnly = flag("confirmationAppOnly"),
    )
}

private fun centsUsd(cents: Long): String = com.tribetails.auntieos.web.util.formatUsdCents(cents)

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
        // #1511: the record exists and only the email does not, so this is read
        // before the "did not go out" branches.
        outcome.confirmationAppOnly -> " The confirmation reached the household in the app only. $APP_ONLY_NOTE"
        outcome.householdNoPortalAccount ->
            " The confirmation email did not go out: the household has no portal account."
        else -> " The confirmation email did not go out. Let the household know another way."
    }
    val office = if (outcome.officeNoticePending) {
        " The office copy of the payment notice did not go out, because the admin roster could not be read. The household copy is not affected."
    } else ""
    val credit = if (outcome.creditedToAccountCents > 0) {
        " ${centsUsd(outcome.creditedToAccountCents)} has been added to the household's account credit. It stays there until you apply an amount to an invoice."
    } else ""
    return head + household + office + credit
}

/**
 * What the dialog shows when the call is refused or fails. The server's own
 * message goes through verbatim: it names the reason (a draft, a settled
 * invoice, an apply larger than the payment) better than any paraphrase here.
 */
fun recordPaymentRefusalText(serverMessage: String): String =
    if (serverMessage == PAYMENT_ANSWER_UNREADABLE_MESSAGE) serverMessage else "Couldn't record payment: $serverMessage"
/**
 * #2315 (#2298 on Android): the server answered `recordPayment` and the answer
 * could not be read. The call went through, so the payment may be recorded:
 * the dialog must not say it was not, and shows no decoder wording. The key is
 * kept on an Err, so pressing Record again lands on the same payment.
 */
const val PAYMENT_ANSWER_UNREADABLE_MESSAGE: String =
    "The payment could not be confirmed. Check the invoice before recording it again."
/**
 * #825 and #881: ONE KEY PER SUBMISSION, NOT PER PRESS.
 *
 * A failed or lost attempt leaves the dialog open with every field filled in,
 * so the next press is a retry of the same payment and must carry the same key;
 * the server then answers it from the first attempt's row instead of recording
 * the money twice. A changed entry is a different payment and gets a new key.
 * [release] after the server has answered Ok, so a second, genuinely identical
 * payment (two equal cash instalments on one day) is not replayed as the first.
 *
 * #2297, the same rules as admin web and Android:
 *   - ONE OPENING, ONE KEY. The dialog calls [release] when it opens and when
 *     it is dismissed, so a payment entered after Cancel is a new payment even
 *     when every box matches. Before this the key lived as long as the invoice
 *     screen, and that second payment was answered with the first.
 *   - ONLY THE MONEY decides "a changed entry" ([paymentEntryFigures]). Fixing
 *     the note, method, reference or date after a lost reply is a retry.
 *   - [pin] when a failed press could not be checked against the invoice's
 *     payments: nobody knows whether it landed, so the key is held for the rest
 *     of the opening whatever is edited.
 */
class PaymentSubmissionKeys(private val mint: () -> String = { mintPaymentIdempotencyKey() }) {
    private var held: Pair<String, String>? = null
    private var pinned: Boolean = false

    fun keyFor(signature: String): String {
        held?.let { (sig, key) -> if (pinned || sig == signature) return key }
        val minted = mint()
        held = signature to minted
        pinned = false
        return minted
    }

    /** The key held now, or null. */
    val current: String? get() = held?.second

    fun pin() {
        if (held != null) pinned = true
    }

    fun release() {
        held = null
        pinned = false
    }
}

/**
 * #2297: the money figures of one entry, which are all that make two presses
 * different payments. The invoice is in it so a key can never cross invoices.
 */
fun paymentEntryFigures(entry: InvoicePaymentEntry): String = listOf(
    entry.payment.invoiceId,
    entry.payment.amount.toString(),
    entry.payment.tip.toString(),
    entry.applyAmount.toString(),
    entry.fee.toString(),
    entry.creditToAccountCents.toString(),
).joinToString("\u001F")

/**
 * #2297: the press that failed did land, and the second ask for its answer
 * failed as well. The payment is on the invoice; only its answer is missing.
 * The same words as admin web and Android.
 */
const val PAYMENT_LANDED_NO_ANSWER: String =
    "The payment was recorded, but this screen did not get its details back. Check the payments below before recording another one."

/** #2297: the [WriteResult.Err.code] that marks [PAYMENT_LANDED_NO_ANSWER]. The dialog closes on it. */
const val PAYMENT_LANDED_NO_ANSWER_CODE: String = "payment_landed_no_answer"

/**
 * The dialog's submit, outside Compose so it is testable: take the held key for
 * this entry, call the callable, release the key only on Ok. On Err the key is
 * kept, so a re-press of the same entry sends the same key.
 *
 * #2297: A FAILED PRESS MAY HAVE LANDED. This console cannot tell a refusal
 * from a lost answer by the error alone, so after every failure the invoice's
 * payments are read and the row this key writes is looked for, before the
 * dialog can be pressed again.
 *   - Found: it landed. The same key is sent once more, which the server
 *     answers from the stored row (finishing any notice it still owes) without
 *     recording anything twice. If that ask fails too, the result is an Err
 *     carrying [PAYMENT_LANDED_NO_ANSWER_CODE], and the key is let go.
 *   - Not found: the Err is returned and the key is kept.
 *   - The read failed: the Err is returned and the key is pinned.
 */
suspend fun submitInvoicePayment(
    client: FirestoreClient,
    entry: InvoicePaymentEntry,
    keys: PaymentSubmissionKeys,
): WriteResult<RecordPaymentOutcome> = submitInvoicePayment(
    entry = entry,
    keys = keys,
    record = { key -> client.recordInvoicePayment(entry, idempotencyKey = key) },
    readLedger = { client.getInvoiceLedgerPayments(entry.payment.invoiceId) },
)

/** [submitInvoicePayment] with its two calls passed in, so each order of answers is a unit test. */
suspend fun submitInvoicePayment(
    entry: InvoicePaymentEntry,
    keys: PaymentSubmissionKeys,
    record: suspend (key: String) -> WriteResult<RecordPaymentOutcome>,
    readLedger: suspend () -> WriteResult<InvoiceLedgerPayments>,
): WriteResult<RecordPaymentOutcome> {
    val key = keys.keyFor(paymentEntryFigures(entry))
    val first = record(key)
    if (first is WriteResult.Ok) {
        keys.release()
        return first
    }
    val landed = when (val ledger = readLedger()) {
        is WriteResult.Ok -> ledger.value.linked.any { it.paymentId == key }
        is WriteResult.Err -> {
            keys.pin()
            return first
        }
    }
    if (!landed) return first
    val again = record(key)
    keys.release()
    return if (again is WriteResult.Ok) again else WriteResult.Err(PAYMENT_LANDED_NO_ANSWER, PAYMENT_LANDED_NO_ANSWER_CODE)
}
