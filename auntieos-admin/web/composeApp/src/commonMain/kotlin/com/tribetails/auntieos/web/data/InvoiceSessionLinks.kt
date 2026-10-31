package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull

/**
 * #1197: what the `linkInvoiceSessions` callable answered for one save.
 *
 * `added` and `removed` are the DELTA the server derived inside its
 * transaction against the stored set; the console sends the full new set and
 * never computes them itself. `sessionIds` is the stored set after the write.
 */
data class InvoiceSessionLinkOutcome(
    val invoiceId: String,
    val sessionIds: List<String>,
    val added: List<String>,
    val removed: List<String>,
    val status: String,
    val editScope: String,
)

/**
 * The request body: the invoice id and the invoice's COMPLETE new session set,
 * de-duplicated in the order the operator picked them. `[]` unlinks everything.
 */
internal fun linkInvoiceSessionsPayloadOf(invoiceId: String, sessionIds: Collection<String>): JsonObject =
    buildJsonObject {
        put("invoiceId", JsonPrimitive(invoiceId))
        put("sessionIds", JsonArray(sessionIds.distinct().map { JsonPrimitive(it) }))
    }

private val invoiceSessionLinksJson = Json { ignoreUnknownKeys = true; isLenient = true }

/**
 * Decodes the callable's answer, the same rule as Android's
 * `invoiceSessionLinksOf`: `sessionIds` falls back to the requested set ONLY
 * when the key is absent. A present-and-empty array is the server saying every
 * visit was unlinked, and must stay empty. `invoiceId` falls back when blank.
 * `added`, `removed`, `status` and `editScope` are the server's own derivation
 * and have nothing to fall back to.
 */
internal fun decodeInvoiceSessionLinkOutcome(
    raw: String,
    requestedInvoiceId: String,
    requestedSessionIds: Collection<String>,
): InvoiceSessionLinkOutcome {
    val obj = runCatching { invoiceSessionLinksJson.parseToJsonElement(raw) as? JsonObject }.getOrNull()
        ?: JsonObject(emptyMap())
    fun strings(e: JsonElement?): List<String>? =
        (e as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }
    fun text(key: String): String = (obj[key] as? JsonPrimitive)?.contentOrNull.orEmpty()
    return InvoiceSessionLinkOutcome(
        invoiceId = text("invoiceId").ifBlank { requestedInvoiceId },
        sessionIds = strings(obj["sessionIds"]) ?: requestedSessionIds.distinct(),
        added = strings(obj["added"]).orEmpty(),
        removed = strings(obj["removed"]).orEmpty(),
        status = text("status"),
        editScope = text("editScope"),
    )
}

/** The confirmation the console shows once the server has saved the set. */
internal fun invoiceSessionLinksSavedText(outcome: InvoiceSessionLinkOutcome): String {
    val a = outcome.added.size
    val r = outcome.removed.size
    if (a == 0 && r == 0) return "Linked visits unchanged."
    val parts = buildList {
        if (a > 0) add("$a linked")
        if (r > 0) add("$r unlinked")
    }
    return "Visits saved: ${parts.joinToString(", ")}."
}
