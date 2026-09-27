package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
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
 * Q6 (operator ruling 2026-09-27): the owner gives a household account credit
 * (amount, reason) through `giveAccountCredit`, and reads the household's credit
 * history through `getAccountCreditHistory`. Both callables live in
 * `mytribe/functions`; this console has no generated contracts, so the shapes
 * below are hand-written from `giveAccountCredit.ts` and
 * `getAccountCreditHistory.ts`, and every decoder ignores keys it does not know.
 *
 * The server keeps the balance (`families/{id}.accountBalanceCents`) and writes
 * the audit entry. The console only ever repeats the server's figures back.
 */

/** One give-credit submission, as the dialog hands it over. */
data class GiveCreditEntry(
    val kinfolkId: String,
    /** Integer cents, more than zero, at most [MAX_GIVE_CREDIT_CENTS]. */
    val amountCents: Long,
    /** Why, already trimmed. */
    val reason: String,
)

/** The server's cap, $5,000.00 (`MAX_GIVEN_CREDIT_CENTS` in `lib/creditLedger.ts`). */
const val MAX_GIVE_CREDIT_CENTS: Long = 500_000L

/** The server's reason limit (`MAX_CREDIT_REASON_LENGTH`). */
const val MAX_GIVE_CREDIT_REASON_LENGTH: Int = 1000

/** The `giveAccountCredit` request. The key is REQUIRED on this callable. */
fun giveAccountCreditPayload(entry: GiveCreditEntry, kinfolkId: String, idempotencyKey: String): JsonObject =
    buildJsonObject {
        put("kinfolkId", kinfolkId)
        put("amountCents", entry.amountCents)
        put("reason", entry.reason)
        put("idempotencyKey", idempotencyKey)
    }

/** What `giveAccountCredit` answered. */
data class GiveCreditOutcome(
    val creditId: String,
    val amountCents: Long,
    /** The balance right after the credit, as the SERVER computed it. */
    val newAccountBalanceCents: Long,
    val replayed: Boolean,
)

private val accountCreditJson = Json { ignoreUnknownKeys = true; isLenient = true }

/** Decodes the answer. A body with no `creditId` or no balance is not a given credit. */
fun decodeGiveCreditOutcome(body: String): GiveCreditOutcome {
    val obj = accountCreditJson.parseToJsonElement(body).jsonObject
    val id = obj["creditId"]?.jsonPrimitive?.contentOrNull.orEmpty()
    require(id.isNotBlank()) { "giveAccountCredit answered without a creditId" }
    val balance = obj["newAccountBalanceCents"]?.jsonPrimitive?.longOrNull
    requireNotNull(balance) { "giveAccountCredit answered without the new balance" }
    return GiveCreditOutcome(
        creditId = id,
        amountCents = obj["amountCents"]?.jsonPrimitive?.longOrNull ?: 0L,
        newAccountBalanceCents = balance,
        replayed = obj["replayed"]?.jsonPrimitive?.booleanOrNull == true,
    )
}

/** One use of part of a given credit. */
data class CreditApplicationDto(
    val appliedAtMs: Long,
    val amountCents: Long,
    val invoiceId: String,
    val invoiceNumber: String?,
)

/** One credit the office gave, with what happened to it. */
data class GivenCreditDto(
    val creditId: String,
    val amountCents: Long,
    val reason: String,
    val givenAtMs: Long,
    val remainingCents: Long,
    val fullyAppliedAtMs: Long?,
    val applications: List<CreditApplicationDto>,
)

/** One time credit was spent on an invoice. */
data class CreditUseDto(
    val useId: String,
    val usedAtMs: Long,
    val amountCents: Long,
    val invoiceId: String,
    val invoiceNumber: String?,
)

/** The household's credit history. Lists newest first, as the server sends them. */
data class AccountCreditHistory(
    val kinfolkId: String,
    val accountBalanceCents: Long,
    val credits: List<GivenCreditDto>,
    val uses: List<CreditUseDto>,
)

private fun JsonObject.str(key: String): String = (this[key] as? JsonPrimitive)?.contentOrNull.orEmpty()
private fun JsonObject.strOrNull(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
private fun JsonObject.long(key: String): Long = (this[key] as? JsonPrimitive)?.longOrNull ?: 0L
private fun JsonObject.longOrNull(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull
private fun JsonObject.objects(key: String): List<JsonObject> =
    (this[key] as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()

/** Decodes `getAccountCreditHistory`. Missing lists read as empty, never as an error. */
fun decodeAccountCreditHistory(body: String): AccountCreditHistory {
    val obj = accountCreditJson.parseToJsonElement(body).jsonObject
    return AccountCreditHistory(
        kinfolkId = obj.str("kinfolkId"),
        accountBalanceCents = obj.long("accountBalanceCents"),
        credits = obj.objects("credits").map { c ->
            GivenCreditDto(
                creditId = c.str("creditId"),
                amountCents = c.long("amountCents"),
                reason = c.str("reason"),
                givenAtMs = c.long("givenAtMs"),
                remainingCents = c.long("remainingCents"),
                fullyAppliedAtMs = c.longOrNull("fullyAppliedAtMs"),
                applications = c.objects("applications").map { a ->
                    CreditApplicationDto(
                        appliedAtMs = a.long("appliedAtMs"),
                        amountCents = a.long("amountCents"),
                        invoiceId = a.str("invoiceId"),
                        invoiceNumber = a.strOrNull("invoiceNumber"),
                    )
                },
            )
        },
        uses = obj.objects("uses").map { u ->
            CreditUseDto(
                useId = u.str("useId"),
                usedAtMs = u.long("usedAtMs"),
                amountCents = u.long("amountCents"),
                invoiceId = u.str("invoiceId"),
                invoiceNumber = u.strOrNull("invoiceNumber"),
            )
        },
    )
}

/**
 * Is this history error the server saying "not for you"? Then the panel hides
 * rather than showing an error. The desktop callable path keeps only the
 * server's message, so this reads the messages the gate sends
 * (`getAccountCreditHistory.ts`, `refuseAuntie`, `resolveInvoiceWriteActor`)
 * and the raw status name when a transport reports it.
 */
fun isCreditHistoryRefusal(message: String): Boolean {
    val m = message.lowercase()
    return "permission-denied" in m ||
        "permission_denied" in m ||
        "billing access is required" in m ||
        "not available to caretaker" in m ||
        "outside your test sandbox" in m
}

/** What the history read came to. [Hidden] means this account may not see it. */
sealed class CreditHistoryLoad {
    data class Loaded(val history: AccountCreditHistory) : CreditHistoryLoad()
    object Hidden : CreditHistoryLoad()
    data class Failed(val message: String) : CreditHistoryLoad()
}

/** Reads the history. A refusal becomes [CreditHistoryLoad.Hidden], anything else that fails is shown. */
suspend fun loadAccountCreditHistory(client: FirestoreClient, kinfolkId: String): CreditHistoryLoad =
    when (val r = client.getAccountCreditHistory(kinfolkId)) {
        is WriteResult.Ok -> CreditHistoryLoad.Loaded(r.value)
        is WriteResult.Err ->
            if (isCreditHistoryRefusal(r.message)) CreditHistoryLoad.Hidden else CreditHistoryLoad.Failed(r.message)
    }

/**
 * One key per submission, not per press, the same rule as
 * [PaymentSubmissionKeys]: a failed attempt keeps the dialog filled in, so the
 * next press of the same credit carries the same key and the server answers it
 * from the first attempt instead of giving the credit twice. Released on Ok, so
 * a second, identical credit given on purpose is not replayed as the first.
 */
class GiveCreditSubmissionKeys(private val mint: () -> String = { mintGiveCreditIdempotencyKey() }) {
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

/** The dialog's submit, outside Compose so it is testable. Releases the key only on Ok. */
suspend fun submitGiveCredit(
    client: FirestoreClient,
    entry: GiveCreditEntry,
    keys: GiveCreditSubmissionKeys,
): WriteResult<GiveCreditOutcome> {
    val key = keys.keyFor(entry.toString())
    val r = client.giveAccountCredit(entry, idempotencyKey = key)
    if (r is WriteResult.Ok) keys.release()
    return r
}
