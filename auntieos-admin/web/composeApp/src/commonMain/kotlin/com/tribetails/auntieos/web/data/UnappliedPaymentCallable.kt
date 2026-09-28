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
 * #1003: card payments the Stripe webhook could not apply (the invoice was
 * already paid, or the checkout round was stale) wait on the owner's decision.
 * `listUnappliedPayments` reads them, with the household's open invoices, and
 * `resolveUnappliedPayment` records what the payment becomes: account credit,
 * money applied to one open invoice, and the rest kept on the payment. There
 * are no refunds.
 *
 * Both callables live in `mytribe/functions/src/admin/`. This console has no
 * generated contracts, so the shapes are hand-written from those files, the
 * same way `AccountCreditCallable.kt` does it, and every decoder ignores keys
 * it does not know.
 */

/** One flagged payment. [reason] is a plain sentence that starts lower-case. */
data class UnappliedPaymentDto(
    val paymentId: String,
    val kinfolkId: String,
    val invoiceId: String,
    val invoiceNumber: String,
    val amountCents: Long,
    /** False when Stripe reported no amount: then only the all-zero decision is accepted. */
    val amountResolved: Boolean,
    val feeCents: Long,
    val reason: String,
    val receivedAtMs: Long,
    val referenceNumber: String,
)

/** An invoice a decision may apply money to. */
data class OpenInvoiceDto(
    val invoiceId: String,
    val invoiceNumber: String,
    val amountDueCents: Long,
)

/** What `listUnappliedPayments` answered. Payments newest first, as the server sends them. */
data class UnappliedPaymentsList(
    val kinfolkId: String,
    val payments: List<UnappliedPaymentDto>,
    val openInvoices: List<OpenInvoiceDto>,
)

/** One decision, as the dialog hands it over. Built from the form fields only. */
data class UnappliedDecision(
    val paymentId: String,
    val creditCents: Long,
    /** Trimmed; "" when [creditCents] is 0. */
    val creditReason: String,
    /** "" when [applyCents] is 0. */
    val applyInvoiceId: String,
    val applyCents: Long,
)

/** What `resolveUnappliedPayment` answered. The result note repeats only these figures. */
data class UnappliedDecisionOutcome(
    val paymentId: String,
    val kinfolkId: String,
    val paymentCents: Long,
    val creditedCents: Long,
    val creditId: String,
    val appliedCents: Long,
    val appliedInvoiceId: String,
    val appliedInvoiceNumber: String,
    /** 'settled' | 'partial' | ... | '' */
    val appliedInvoiceState: String,
    val appliedInvoiceAmountDueCents: Long,
    val keptCents: Long,
    val newAccountBalanceCents: Long,
    val replayed: Boolean,
)

private val unappliedJson = Json { ignoreUnknownKeys = true; isLenient = true }

private fun JsonObject.s(key: String): String = (this[key] as? JsonPrimitive)?.contentOrNull.orEmpty()
private fun JsonObject.l(key: String): Long = (this[key] as? JsonPrimitive)?.longOrNull ?: 0L
private fun JsonObject.lOrNull(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull
private fun JsonObject.b(key: String): Boolean = (this[key] as? JsonPrimitive)?.booleanOrNull == true
private fun JsonObject.objs(key: String): List<JsonObject> =
    (this[key] as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()

/** The `listUnappliedPayments` request. */
fun listUnappliedPaymentsPayload(kinfolkId: String): JsonObject =
    buildJsonObject { put("kinfolkId", kinfolkId) }

/** Decodes `listUnappliedPayments`. Missing lists read as empty. */
fun decodeUnappliedPaymentsList(body: String): UnappliedPaymentsList {
    val obj = unappliedJson.parseToJsonElement(body).jsonObject
    return UnappliedPaymentsList(
        kinfolkId = obj.s("kinfolkId"),
        payments = obj.objs("payments").map { p ->
            UnappliedPaymentDto(
                paymentId = p.s("paymentId"),
                kinfolkId = p.s("kinfolkId"),
                invoiceId = p.s("invoiceId"),
                invoiceNumber = p.s("invoiceNumber"),
                amountCents = p.l("amountCents"),
                amountResolved = p.b("amountResolved"),
                feeCents = p.l("feeCents"),
                reason = p.s("reason"),
                receivedAtMs = p.l("receivedAtMs"),
                referenceNumber = p.s("referenceNumber"),
            )
        }.filter { it.paymentId.isNotBlank() },
        openInvoices = obj.objs("openInvoices").map { i ->
            OpenInvoiceDto(
                invoiceId = i.s("invoiceId"),
                invoiceNumber = i.s("invoiceNumber"),
                amountDueCents = i.l("amountDueCents"),
            )
        }.filter { it.invoiceId.isNotBlank() },
    )
}

/**
 * The `resolveUnappliedPayment` request. Every arg is required by the server;
 * the reason is sent as "" when there is no credit, and the invoice id as ""
 * when nothing is applied, whatever the form still holds.
 */
fun resolveUnappliedPaymentPayload(decision: UnappliedDecision, idempotencyKey: String): JsonObject =
    buildJsonObject {
        put("paymentId", decision.paymentId)
        put("creditCents", decision.creditCents)
        put("creditReason", if (decision.creditCents > 0L) decision.creditReason.trim() else "")
        put("applyInvoiceId", if (decision.applyCents > 0L) decision.applyInvoiceId else "")
        put("applyCents", decision.applyCents)
        put("idempotencyKey", idempotencyKey)
    }

/** Decodes the answer. A body with no paymentId, no kept amount or no balance is not a saved decision. */
fun decodeUnappliedDecisionOutcome(body: String): UnappliedDecisionOutcome {
    val obj = unappliedJson.parseToJsonElement(body).jsonObject
    val id = obj.s("paymentId")
    require(id.isNotBlank()) { "resolveUnappliedPayment answered without a paymentId" }
    val kept = obj.lOrNull("keptCents")
    requireNotNull(kept) { "resolveUnappliedPayment answered without the kept amount" }
    val balance = obj.lOrNull("newAccountBalanceCents")
    requireNotNull(balance) { "resolveUnappliedPayment answered without the new balance" }
    return UnappliedDecisionOutcome(
        paymentId = id,
        kinfolkId = obj.s("kinfolkId"),
        paymentCents = obj.l("paymentCents"),
        creditedCents = obj.l("creditedCents"),
        creditId = obj.s("creditId"),
        appliedCents = obj.l("appliedCents"),
        appliedInvoiceId = obj.s("appliedInvoiceId"),
        appliedInvoiceNumber = obj.s("appliedInvoiceNumber"),
        appliedInvoiceState = obj.s("appliedInvoiceState"),
        appliedInvoiceAmountDueCents = obj.l("appliedInvoiceAmountDueCents"),
        keptCents = kept,
        newAccountBalanceCents = balance,
        replayed = obj.b("replayed"),
    )
}

/** What the list read came to. [Hidden] means this account may not see it (same gate as the credit history). */
sealed class UnappliedPaymentsLoad {
    data class Loaded(val list: UnappliedPaymentsList) : UnappliedPaymentsLoad()
    object Hidden : UnappliedPaymentsLoad()
    data class Failed(val message: String) : UnappliedPaymentsLoad()
}

/** Reads the list. A refusal hides the sub-section; anything else that fails is shown. */
suspend fun loadUnappliedPayments(client: FirestoreClient, kinfolkId: String): UnappliedPaymentsLoad =
    when (val r = client.listUnappliedPayments(kinfolkId)) {
        is WriteResult.Ok -> UnappliedPaymentsLoad.Loaded(r.value)
        is WriteResult.Err ->
            if (isCreditHistoryRefusal(r.message)) UnappliedPaymentsLoad.Hidden else UnappliedPaymentsLoad.Failed(r.message)
    }

/**
 * One key per submission, the same rule as [GiveCreditSubmissionKeys]: a failed
 * attempt keeps the key so pressing Save decision again lands on the same
 * decision; any change to the decision mints a fresh one; an Ok releases it.
 */
class UnappliedDecisionSubmissionKeys(private val mint: () -> String = { mintUnappliedDecisionIdempotencyKey() }) {
    private var held: Pair<UnappliedDecision, String>? = null

    fun keyFor(decision: UnappliedDecision): String {
        held?.let { (d, key) -> if (d == decision) return key }
        val minted = mint()
        held = decision to minted
        return minted
    }

    fun release() {
        held = null
    }
}

/** The dialog's save, outside Compose so it is testable. Releases the key only on Ok. */
suspend fun submitUnappliedDecision(
    client: FirestoreClient,
    decision: UnappliedDecision,
    keys: UnappliedDecisionSubmissionKeys,
): WriteResult<UnappliedDecisionOutcome> {
    val key = keys.keyFor(decision)
    val r = client.resolveUnappliedPayment(decision, idempotencyKey = key)
    if (r is WriteResult.Ok) keys.release()
    return r
}
