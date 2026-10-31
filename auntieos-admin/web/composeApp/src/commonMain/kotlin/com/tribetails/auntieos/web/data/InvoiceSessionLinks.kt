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

/**
 * #1254: true when this visit's own back-link names an invoice OTHER than
 * [invoiceId] and the visit is not already in [storedIds], the invoice's saved
 * set. The Link Sessions picker shows such a visit but will not tick it, and
 * the `linkInvoiceSessions` callable refuses it with `session_on_other_invoice`.
 *
 * Blank and whitespace back-links are unclaimed, the rule
 * `listUninvoicedSessions` uses. A visit already in the stored set stays
 * togglable whatever its back-link says, so a half-link can be undone. Same
 * rule as admin web's `onOtherInvoice` and admin Android's
 * `linkPickerOnOtherInvoice`.
 */
internal fun linkPickerOnOtherInvoice(
    session: KinCareSession,
    invoiceId: String,
    storedIds: Collection<String>,
): Boolean {
    if (session._id in storedIds) return false
    val claimed = session.invoiceId.trim()
    return claimed.isNotEmpty() && claimed != invoiceId
}

/**
 * #1254: the picker's toggle. Unticks anything; refuses to tick a visit
 * [linkPickerOnOtherInvoice] marks, so the rule holds whatever calls it.
 */
internal fun toggleLinkPick(
    pending: Set<String>,
    sessionId: String,
    sessions: List<KinCareSession>,
    invoiceId: String,
    storedIds: Collection<String>,
): Set<String> {
    if (sessionId in pending) return pending - sessionId
    val session = sessions.firstOrNull { it._id == sessionId }
    if (session != null && linkPickerOnOtherInvoice(session, invoiceId, storedIds)) return pending
    return pending + sessionId
}
