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
    /**
     * #2091: the linked visits (after the save) that no line on the invoice
     * bills. Linking marks them billed by this invoice without adding a price,
     * and [invoiceSessionLinksSavedText] says so. Empty when the server is an
     * older build that does not send it. Last, so positional callers keep working.
     */
    val linkedWithoutLine: List<String> = emptyList(),
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
        linkedWithoutLine = strings(obj["linkedWithoutLine"]).orEmpty(),
        status = text("status"),
        editScope = text("editScope"),
    )
}

/**
 * The confirmation the console shows once the server has saved the set. Same
 * wording as admin web and Android. #2091: a visit linked with no line to bill
 * it is named as not priced.
 */
internal fun invoiceSessionLinksSavedText(outcome: InvoiceSessionLinkOutcome): String {
    val a = outcome.added.size
    val r = outcome.removed.size
    if (a == 0 && r == 0) return "Linked visits unchanged."
    val parts = buildList {
        if (a > 0) add("$a linked")
        if (r > 0) add("$r unlinked")
    }
    val withoutLine = outcome.linkedWithoutLine.toSet()
    val unpriced = outcome.added.count { it in withoutLine }
    val priceNote = when {
        unpriced == 0 -> ""
        unpriced == 1 -> " The linked visit no longer shows as un-invoiced, and its price was not added to this invoice."
        else -> " The $unpriced linked visits no longer show as un-invoiced, and their prices were not added to this invoice."
    }
    return "Visits saved: ${parts.joinToString(", ")}.$priceNote"
}
/** #2091: the warning shown while a newly ticked visit waits to be saved. Same words as web and Android. */
internal const val LINK_ADDS_NO_PRICE_TITLE = "Linking does not change the total"
internal const val LINK_ADDS_NO_PRICE_TEXT =
    "A visit you link here is marked as billed by this invoice and leaves the un-invoiced list, but its " +
        "price is not added. To bill a visit's price, leave it unticked and put it on an invoice from New invoice."
/**
 * #2091: the visits a line on the invoice bills, read off the RAW stored
 * `lineItems` (anything that is not a list of objects reads as none). The
 * picker keeps them ticked and will not untick them, and `linkInvoiceSessions`
 * refuses the unlink with `session_billed_on_line`: unlinking a visit a line
 * still bills would put billed work back on the un-invoiced list. Removing the
 * line in Edit unlinks it (#1970). Same rule as admin web and Android.
 */
internal fun linkPickerBilledIds(lineItems: JsonElement?): Set<String> =
    (lineItems as? JsonArray).orEmpty()
        .mapNotNull { ((it as? JsonObject)?.get("sessionId") as? JsonPrimitive)?.takeIf { p -> p.isString }?.content?.trim() }
        .filter { it.isNotEmpty() }
        .toSet()

/**
 * #1609: a CANCELLED visit is work that did not happen, so the picker shows it
 * but will not newly tick it, and `linkInvoiceSessions` refuses it with
 * `session_cancelled`. One already in [storedIds] stays togglable so it can be
 * unlinked. Same rule as admin web and admin Android.
 */
internal fun linkPickerCancelled(session: KinCareSession, storedIds: Collection<String>): Boolean {
    if (session._id in storedIds) return false
    val s = session.status.trim().uppercase()
    return s == "CANCELLED" || s == "CANCELED"
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
    /** #2091: visits a line bills; they stay ticked. */
    billedIds: Set<String> = emptySet(),
): Set<String> {
    if (sessionId in pending) return if (sessionId in billedIds) pending else pending - sessionId
    val session = sessions.firstOrNull { it._id == sessionId }
    if (session != null && (linkPickerOnOtherInvoice(session, invoiceId, storedIds) || linkPickerCancelled(session, storedIds))) {
        return pending
    }
    return pending + sessionId
}
