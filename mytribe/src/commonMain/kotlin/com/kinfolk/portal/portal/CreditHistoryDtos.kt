package com.kinfolk.portal.portal

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Q6: the answer of `getAccountCreditHistory`
 * (mytribe/functions/src/portal/getAccountCreditHistory.ts). Both lists come
 * newest first. Read only: the portal never gives credit.
 */
data class CreditHistoryResult(
    val kinfolkId: String,
    val accountBalanceCents: Long,
    val credits: List<GivenCredit>,
    val uses: List<CreditUse>,
)

/** One credit the office gave, with what has been spent of it. */
data class GivenCredit(
    val creditId: String,
    val amountCents: Long,
    val reason: String,
    val givenAtMs: Long,
    val remainingCents: Long,
    /** When the last of it was spent, or null while any is left. */
    val fullyAppliedAtMs: Long?,
    /** Every use of part of it, oldest first. */
    val applications: List<CreditApplication>,
)

data class CreditApplication(
    val appliedAtMs: Long,
    val amountCents: Long,
    val invoiceId: String,
    val invoiceNumber: String?,
)

/** One time credit was spent on an invoice, whichever credit it came from. */
data class CreditUse(
    val useId: String,
    val usedAtMs: Long,
    val amountCents: Long,
    val invoiceId: String,
    val invoiceNumber: String?,
)

private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
private fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull

internal fun decodeCreditHistory(raw: JsonObject): CreditHistoryResult = CreditHistoryResult(
    kinfolkId = raw.str("kinfolkId").orEmpty(),
    accountBalanceCents = raw.long("accountBalanceCents") ?: 0L,
    credits = (raw["credits"] as? JsonArray).orEmpty().mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        GivenCredit(
            creditId = o.str("creditId") ?: return@mapNotNull null,
            amountCents = o.long("amountCents") ?: 0L,
            reason = o.str("reason").orEmpty(),
            givenAtMs = o.long("givenAtMs") ?: 0L,
            remainingCents = o.long("remainingCents") ?: 0L,
            fullyAppliedAtMs = o.long("fullyAppliedAtMs"),
            applications = (o["applications"] as? JsonArray).orEmpty().mapNotNull { a ->
                val ao = a as? JsonObject ?: return@mapNotNull null
                CreditApplication(
                    appliedAtMs = ao.long("appliedAtMs") ?: return@mapNotNull null,
                    amountCents = ao.long("amountCents") ?: 0L,
                    invoiceId = ao.str("invoiceId").orEmpty(),
                    invoiceNumber = ao.str("invoiceNumber"),
                )
            },
        )
    },
    uses = (raw["uses"] as? JsonArray).orEmpty().mapNotNull { el ->
        val o = el as? JsonObject ?: return@mapNotNull null
        CreditUse(
            useId = o.str("useId") ?: return@mapNotNull null,
            usedAtMs = o.long("usedAtMs") ?: 0L,
            amountCents = o.long("amountCents") ?: 0L,
            invoiceId = o.str("invoiceId").orEmpty(),
            invoiceNumber = o.str("invoiceNumber"),
        )
    },
)
