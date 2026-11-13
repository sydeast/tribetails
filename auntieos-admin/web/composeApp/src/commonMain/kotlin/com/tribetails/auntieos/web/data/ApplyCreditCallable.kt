package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * #1872 (operator ruling 2026-11-11): account credit is never spent
 * automatically. It goes onto an invoice only as an amount the admin enters,
 * through the `applyAccountCredit` callable in `mytribe/functions`. This console
 * has no generated contracts, so the shapes below are hand-written from
 * `admin/applyAccountCredit.ts`.
 *
 * The server checks the amount against the household's credit and the invoice's
 * balance, writes the payment, both balances, the credit history entry and the
 * Activity Log line in one transaction, and refuses in plain words. The console
 * only ever repeats the server's figures back.
 */

/** One apply-credit submission, as the invoice detail hands it over. */
data class ApplyCreditEntry(
    val invoiceId: String,
    /** Integer cents, more than zero. */
    val amountCents: Long,
)

/** The `applyAccountCredit` request. The key is REQUIRED on this callable. */
fun applyAccountCreditPayload(entry: ApplyCreditEntry, idempotencyKey: String): JsonObject =
    buildJsonObject {
        put("invoiceId", entry.invoiceId)
        put("amountCents", entry.amountCents)
        put("idempotencyKey", idempotencyKey)
    }

/** What `applyAccountCredit` answered. Every figure is the SERVER's. */
data class ApplyCreditOutcome(
    val invoiceId: String,
    val paymentId: String,
    val appliedCents: Long,
    /** The invoice's balance afterwards. */
    val amountDueCents: Long,
    /** What the household still has on account afterwards. */
    val accountBalanceCents: Long,
    val replayed: Boolean,
)

private val applyCreditJson = Json { ignoreUnknownKeys = true; isLenient = true }

/**
 * Decodes the answer, strictly. A body missing the payment or any of the three
 * figures is not an applied credit: reporting one would show money that the
 * server did not say moved.
 */
fun decodeApplyCreditOutcome(body: String): ApplyCreditOutcome {
    val obj = applyCreditJson.parseToJsonElement(body).jsonObject
    require(obj["ok"]?.jsonPrimitive?.booleanOrNull == true) { "applyAccountCredit did not answer ok" }
    val paymentId = obj["paymentId"]?.jsonPrimitive?.contentOrNull.orEmpty()
    require(paymentId.isNotBlank()) { "applyAccountCredit answered without a payment" }
    val applied = requireNotNull(obj["appliedCents"]?.jsonPrimitive?.longOrNull) {
        "applyAccountCredit answered without the amount applied"
    }
    val due = requireNotNull(obj["amountDueCents"]?.jsonPrimitive?.longOrNull) {
        "applyAccountCredit answered without the invoice balance"
    }
    val balance = requireNotNull(obj["accountBalanceCents"]?.jsonPrimitive?.longOrNull) {
        "applyAccountCredit answered without the credit balance"
    }
    return ApplyCreditOutcome(
        invoiceId = obj["invoiceId"]?.jsonPrimitive?.contentOrNull.orEmpty(),
        paymentId = paymentId,
        appliedCents = applied,
        amountDueCents = due,
        accountBalanceCents = balance,
        replayed = obj["replayed"]?.jsonPrimitive?.booleanOrNull == true,
    )
}

/**
 * One key per submission, not per press, the same rule as
 * [GiveCreditSubmissionKeys]: a failed attempt keeps the amount on screen, so
 * the next press of the same amount carries the same key and the server answers
 * it from the first attempt instead of applying the credit twice. A changed
 * amount is a different submission and mints a new key. Released on Ok, so a
 * second, identical amount applied on purpose is not replayed as the first.
 */
class ApplyCreditSubmissionKeys(private val mint: () -> String = { mintApplyCreditIdempotencyKey() }) {
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

/** The submit, outside Compose so it is testable. Releases the key only on Ok. */
suspend fun submitApplyCredit(
    client: FirestoreClient,
    entry: ApplyCreditEntry,
    keys: ApplyCreditSubmissionKeys,
): WriteResult<ApplyCreditOutcome> {
    val key = keys.keyFor(entry.toString())
    val r = client.applyAccountCredit(entry, idempotencyKey = key)
    if (r is WriteResult.Ok) keys.release()
    return r
}
