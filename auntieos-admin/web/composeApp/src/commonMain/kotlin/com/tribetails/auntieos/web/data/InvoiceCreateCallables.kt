package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * #1178: the wire shapes the desktop new-invoice composer needs, matching what
 * admin web and admin Android send.
 *
 * Three callables:
 *   `createInvoice` / `createQuote`   with `termsCode`, `lineItems` and
 *                                     `invoiceDiscountCents` (#408), and no
 *                                     invoice number unless one is supplied.
 *   `listUninvoicedSessions`          a household's completed visits that no
 *                                     invoice bills for yet.
 *   `setSessionDoNotInvoice`          takes visits off that list, or puts them
 *                                     back.
 *
 * Desktop has no generated contract classes, so these are written by hand. The
 * field names and the omit-versus-send rules are copied from the Android
 * `createInvoiceArgs` / generated `*Args.toPayload()` and the server zod schemas
 * in `mytribe/functions/src/admin/`. Every builder and decoder is pure, so the
 * payload is a unit test.
 */

/**
 * One invoice line, money in integer cents (the server's `LineItem` schema).
 *
 * [sessionId] is the visit this line bills for, blank on a line typed by hand.
 */
data class InvoiceLineItem(
    val description: String,
    val qty: Double,
    val unitCents: Long,
    val discountCents: Long = 0L,
    val sessionId: String = "",
)

/** One un-invoiced completed visit. [unitCents] null means the rate card could not price it. */
data class UninvoicedSession(
    val sessionId: String,
    val kinfolkId: String,
    val serviceType: String,
    val durationMinutes: Double,
    val startTime: String,
    val unitCents: Long?,
)

data class UninvoicedUnpriceable(val sessionId: String, val serviceType: String)

data class UninvoicedUnplaceable(val sessionId: String, val kinfolkId: String)

/** A visit marked do not invoice. */
data class UninvoicedExcluded(
    val sessionId: String,
    val kinfolkId: String,
    val serviceType: String,
    val startTime: String,
    val reason: String,
)

/** Response from `listUninvoicedSessions`. */
data class UninvoicedSessionsResult(
    val sessions: List<UninvoicedSession>,
    val unpriceable: List<UninvoicedUnpriceable>,
    val unplaceable: List<UninvoicedUnplaceable>,
    val excluded: List<UninvoicedExcluded>,
    val rateCardLoaded: Boolean,
    val scanned: Long,
    val truncated: Boolean,
)

/** Response from `setSessionDoNotInvoice`. [changed] counts visits whose state actually moved. */
data class DoNotInvoiceResult(
    val ok: Boolean,
    val doNotInvoice: Boolean,
    val changed: List<String>,
    val unchanged: List<String>,
)

private fun lineItemJson(li: InvoiceLineItem): JsonObject = buildJsonObject {
    put("description", li.description)
    put("qty", li.qty)
    put("unitCents", li.unitCents)
    // Omitted when zero or blank, as Android's toCreateInvoiceLine does: the
    // schema makes both optional, and a hand-typed line has no visit behind it.
    if (li.discountCents != 0L) put("discountCents", li.discountCents)
    if (li.sessionId.isNotBlank()) put("sessionId", li.sessionId)
}

/**
 * The fields `createInvoice` and `createQuote` share.
 *
 * A BLANK INVOICE NUMBER IS OMITTED, so the server assigns the next one in the
 * sequence (`lib/invoiceNumber.ts`).
 *
 * [lineItems] NULL MEANS NO `lineItems` KEY AT ALL, which is the blank path. An
 * empty array is not the same thing: the server reads the key's presence as
 * "this invoice is itemized", and a later `updateInvoice` would then recompute
 * a hand-typed total to $0.
 */
private fun createInvoiceCommonFields(
    invoice: Invoice,
    familyId: String,
    termsCode: String?,
    lineItems: List<InvoiceLineItem>?,
    invoiceDiscountCents: Long?,
    idempotencyKey: String?,
): Map<String, JsonElement> = buildJsonObject {
    put("familyId", familyId)
    idempotencyKey?.let { put("idempotencyKey", it) }
    put("kinfolkName", invoice.kinfolkName)
    if (invoice.invoiceNumber.isNotBlank()) put("invoiceNumber", invoice.invoiceNumber)
    put("client", invoice.client)
    put("address", invoice.address)
    put("date", invoice.date)
    put("terms", invoice.terms)
    put("dueDate", invoice.dueDate)
    termsCode?.let { put("termsCode", it) }
    put("discount", invoice.discount)
    put("total", invoice.total)
    put("amountDue", invoice.amountDue)
    put("sessionIds", buildJsonArray { invoice.sessionIds.forEach { add(JsonPrimitive(it)) } })
    lineItems?.let { lines -> put("lineItems", buildJsonArray { lines.forEach { add(lineItemJson(it)) } }) }
    invoiceDiscountCents?.let { put("invoiceDiscountCents", it) }
}

/** The `createInvoice` request. [familyId] is passed in already scoped for test mode. */
fun createInvoicePayload(
    invoice: Invoice,
    familyId: String,
    termsCode: String? = null,
    lineItems: List<InvoiceLineItem>? = null,
    invoiceDiscountCents: Long? = null,
    idempotencyKey: String? = null,
): JsonObject = JsonObject(
    createInvoiceCommonFields(invoice, familyId, termsCode, lineItems, invoiceDiscountCents, idempotencyKey) +
        ("status" to JsonPrimitive(invoice.status)),
)

/**
 * The `createQuote` request. No `status`: the server mints every quote in QUOTE
 * status whatever the caller sends, so sending one would be a request it ignores.
 */
fun createQuotePayload(
    invoice: Invoice,
    familyId: String,
    sendToKinfolk: Boolean,
    termsCode: String? = null,
    lineItems: List<InvoiceLineItem>? = null,
    invoiceDiscountCents: Long? = null,
    idempotencyKey: String? = null,
): JsonObject = JsonObject(
    createInvoiceCommonFields(invoice, familyId, termsCode, lineItems, invoiceDiscountCents, idempotencyKey) +
        ("sendToKinfolk" to JsonPrimitive(sendToKinfolk)),
)

/** The `listUninvoicedSessions` request. Both dates or neither; the server refuses half a range. */
fun listUninvoicedSessionsPayload(kinfolkId: String, from: String?, to: String?): JsonObject {
    require(kinfolkId.isNotBlank()) { "listUninvoicedSessions requires a household" }
    require((from == null) == (to == null)) { "listUninvoicedSessions needs both dates or neither" }
    return buildJsonObject {
        put("kinfolkId", kinfolkId)
        from?.let { put("from", it) }
        to?.let { put("to", it) }
    }
}

/** The `setSessionDoNotInvoice` request. */
fun setSessionDoNotInvoicePayload(sessionIds: List<String>, doNotInvoice: Boolean, reason: String): JsonObject {
    require(sessionIds.isNotEmpty()) { "setSessionDoNotInvoice requires at least one visit" }
    return buildJsonObject {
        put("sessionIds", buildJsonArray { sessionIds.forEach { add(JsonPrimitive(it)) } })
        put("doNotInvoice", doNotInvoice)
        put("reason", reason)
    }
}

private val invoiceCreateJson = Json { ignoreUnknownKeys = true; isLenient = true }

private fun JsonObject.str(key: String): String =
    (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull.orEmpty()

private fun JsonObject.objects(key: String): List<JsonObject> =
    (this[key] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }

private fun JsonObject.strings(key: String): List<String> =
    (this[key] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }

/**
 * Decodes a `listUninvoicedSessions` response. A missing `unitCents`, or a JSON
 * null, stays null: an unpriced visit is never read as $0.
 */
fun decodeUninvoicedSessionsResult(json: String): UninvoicedSessionsResult {
    val o = invoiceCreateJson.parseToJsonElement(json).jsonObject
    return UninvoicedSessionsResult(
        sessions = o.objects("sessions").map { s ->
            UninvoicedSession(
                sessionId = s.str("sessionId"),
                kinfolkId = s.str("kinfolkId"),
                serviceType = s.str("serviceType"),
                durationMinutes = (s["durationMinutes"] as? JsonPrimitive)?.doubleOrNull ?: 0.0,
                startTime = s.str("startTime"),
                unitCents = (s["unitCents"] as? JsonPrimitive)?.longOrNull,
            )
        }.filter { it.sessionId.isNotBlank() },
        unpriceable = o.objects("unpriceable").map { UninvoicedUnpriceable(it.str("sessionId"), it.str("serviceType")) },
        unplaceable = o.objects("unplaceable").map { UninvoicedUnplaceable(it.str("sessionId"), it.str("kinfolkId")) },
        excluded = o.objects("excluded").map { e ->
            UninvoicedExcluded(
                sessionId = e.str("sessionId"),
                kinfolkId = e.str("kinfolkId"),
                serviceType = e.str("serviceType"),
                startTime = e.str("startTime"),
                reason = e.str("reason"),
            )
        },
        rateCardLoaded = (o["rateCardLoaded"] as? JsonPrimitive)?.booleanOrNull ?: false,
        scanned = (o["scanned"] as? JsonPrimitive)?.longOrNull ?: 0L,
        truncated = (o["truncated"] as? JsonPrimitive)?.booleanOrNull ?: false,
    )
}

/** Decodes a `setSessionDoNotInvoice` response. */
fun decodeDoNotInvoiceResult(json: String): DoNotInvoiceResult {
    val o = invoiceCreateJson.parseToJsonElement(json).jsonObject
    return DoNotInvoiceResult(
        ok = (o["ok"] as? JsonPrimitive)?.booleanOrNull ?: false,
        doNotInvoice = (o["doNotInvoice"] as? JsonPrimitive)?.booleanOrNull ?: false,
        changed = o.strings("changed"),
        unchanged = o.strings("unchanged"),
    )
}
