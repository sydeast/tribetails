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
    /**
     * #2297: the answer came from the row an earlier call with the same key
     * wrote, and this call recorded nothing. Absent from an older function,
     * which reads false.
     */
    val replayed: Boolean = false,
    /**
     * #2297 review: the money on the row this answer describes, in cents, so a
     * replay can be told apart from the press just answered
     * ([answerIsThisEntry]). Absent from an older function, which reads 0.
     */
    val amountCents: Long = 0L,
    val tipCents: Long = 0L,
    val feeCents: Long = 0L,
    val appliedCents: Long = 0L,
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
        replayed = flag("replayed"),
        confirmationAppOnly = flag("confirmationAppOnly"),
        amountCents = obj.cents("amountCents"),
        tipCents = obj.cents("tipCents"),
        feeCents = obj.cents("feeCents"),
        appliedCents = obj.cents("appliedCents"),
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
 * #2297 SUPERSEDES "a changed entry gets a new key". The same rules as admin
 * web (`lib/paymentSubmissionKey.ts`) and Android:
 *   - A KEY IS HELD FROM ITS FIRST PRESS UNTIL THE SERVER ANSWERS ONE,
 *     whatever is edited and across Cancel. The server's create of
 *     `payments/{key}` is the only thing that makes two presses one payment,
 *     and "not found" after a failure can be a payment still committing, so a
 *     new key while an earlier press is unresolved is how a payment gets
 *     recorded twice. An answer lets it go ([settle]).
 *   - A REPLAYED ANSWER IS CHECKED ([settle]). When the presses under the key
 *     had other figures ([paymentEntryFigures]), or came from an earlier
 *     opening of the dialog ([open]), the answer is that earlier payment's,
 *     and the dialog says so instead of reporting it as the figures just typed.
 *   - A KEY NEVER CROSSES INVOICES.
 */
class PaymentSubmissionKeys(private val mint: () -> String = { mintPaymentIdempotencyKey() }) {
    private var key: String? = null
    private var scope: String? = null
    private val figures = mutableSetOf<String>()
    private var keyOpening: Int = 0
    private var opening: Int = 0

    /** A new opening of the dialog. A key still unresolved from an earlier one stays held. */
    fun open() {
        opening += 1
    }

    /** The key for a press of these figures on this invoice, minting one only when none is held. */
    fun keyFor(scope: String, signature: String): String {
        val held = key
        if (held != null && this.scope == scope) {
            figures += signature
            return held
        }
        release()
        val minted = mint()
        key = minted
        this.scope = scope
        keyOpening = opening
        figures += signature
        return minted
    }

    /** The key held now, or null. */
    val current: String? get() = key

    /**
     * The server answered a press under the held key, which lets it go. True
     * when the answer is an earlier entry's: a replay, and the key came from an
     * earlier opening, or the presses under it had other figures and the row's
     * money is not this press's ([sameMoney], from [answerIsThisEntry]). A
     * replay carrying this press's money after a changed figure is this press's
     * own row: the earlier press was refused or never arrived.
     */
    fun settle(replayed: Boolean, sameMoney: Boolean): Boolean {
        val earlier = replayed && key != null && (keyOpening != opening || (figures.size > 1 && !sameMoney))
        release()
        return earlier
    }

    /** The payment is known to be on record without an answer: the next press is a new payment. */
    fun release() {
        key = null
        scope = null
        figures.clear()
    }
}

/**
 * #2297: the money figures of one entry, which tell a replay of an earlier
 * press made with other figures apart ([PaymentSubmissionKeys.settle]).
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
 * #2297 review: is the money on the answered row the money this press sent? A
 * replay of an earlier press with other figures differs; a replay of this
 * press's own row (its first answer was lost) matches. The same rule as admin
 * web's `answerIsThisEntry` and Android's.
 */
fun answerIsThisEntry(answer: RecordPaymentOutcome, entry: InvoicePaymentEntry): Boolean {
    fun cents(dollars: Double): Long = kotlin.math.round(dollars * 100).toLong()
    return answer.amountCents == cents(entry.payment.amount) &&
        answer.tipCents == cents(entry.payment.tip) &&
        answer.feeCents == cents(entry.fee) &&
        answer.appliedCents == cents(entry.applyAmount) &&
        answer.creditedToAccountCents == entry.creditToAccountCents
}
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
 * #2297: the answer is a replay of an earlier press made with other figures, or
 * in an earlier opening of the dialog. Money was recorded once: that earlier
 * press. The same words as admin web and Android.
 */
const val PAYMENT_EARLIER_ON_RECORD: String =
    "An earlier press of Record went through, and that payment is the one on record. The amounts typed after it were not recorded. Check the payments below before recording another one."

/** #2297: the [WriteResult.Err.code] that marks [PAYMENT_EARLIER_ON_RECORD]. The dialog closes on it. */
const val PAYMENT_EARLIER_ON_RECORD_CODE: String = "payment_earlier_on_record"

/**
 * The dialog's submit, outside Compose so it is testable: take the held key for
 * this entry, call the callable, release the key only on Ok. On Err the key is
 * kept, so the next press sends the same key whatever was edited. An Ok that
 * is a replay of an earlier entry comes back as an Err carrying
 * [PAYMENT_EARLIER_ON_RECORD_CODE].
 *
 * #2297: A FAILED PRESS MAY HAVE LANDED. This console cannot tell a refusal
 * from a lost answer by the error alone, so after every failure the invoice's
 * payments are read and the row this key writes is looked for, before the
 * dialog can be pressed again.
 *   - Found: it landed. The same key is sent once more, which the server
 *     answers from the stored row (finishing any notice it still owes) without
 *     recording anything twice. If that ask fails too, the result is an Err
 *     carrying [PAYMENT_LANDED_NO_ANSWER_CODE], and the key is let go.
 *   - Not found, or the read failed: the Err is returned and the key is kept.
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
    val key = keys.keyFor(entry.payment.invoiceId, paymentEntryFigures(entry))
    fun answered(ok: WriteResult.Ok<RecordPaymentOutcome>): WriteResult<RecordPaymentOutcome> =
        if (keys.settle(ok.value.replayed, answerIsThisEntry(ok.value, entry))) {
            WriteResult.Err(PAYMENT_EARLIER_ON_RECORD, PAYMENT_EARLIER_ON_RECORD_CODE)
        } else {
            ok
        }
    val first = record(key)
    if (first is WriteResult.Ok) return answered(first)
    // Whatever the check finds, the key stays held: "not found" can be a
    // payment still committing, and only the same key keeps the next press
    // from recording it a second time.
    val landed = when (val ledger = readLedger()) {
        is WriteResult.Ok -> ledger.value.linked.any { it.paymentId == key }
        is WriteResult.Err -> return first
    }
    if (!landed) return first
    val again = record(key)
    if (again is WriteResult.Ok) return answered(again)
    keys.release()
    return WriteResult.Err(PAYMENT_LANDED_NO_ANSWER, PAYMENT_LANDED_NO_ANSWER_CODE)
}
