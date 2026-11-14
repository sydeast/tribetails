package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.APP_ONLY_NOTE
import com.tribetails.auntieos.web.data.Invoice
import kotlinx.serialization.json.JsonPrimitive

/**
 * #2087 / #2088 / #2195 on the desktop console: what the office can do with a
 * quote once it exists, in the same words as admin web and admin Android. The
 * server is the enforcement; these decide only what the console offers.
 */

/** A quote saved with "Send to kinfolk now" off: a draft only the office sees, sent as a quote. */
fun isQuoteDraft(invoice: Invoice): Boolean =
    invoice.quoteDraft == true && invoice.status.trim().lowercase() == "draft"

/**
 * Whether the office can still turn this quote into an invoice or withdraw it:
 * a quote saved unsent or a sent one (an accepted quote is stamped `open`, so it
 * is neither), and not archived, which is read-only until restored.
 */
fun quoteIsChangeable(invoice: Invoice): Boolean =
    !invoiceIsArchived(invoice) && (isQuoteDraft(invoice) || invoice.status.trim().lowercase() == "quote")

/**
 * #2092: the detail screen's heading. A quote, sent or saved unsent, is named
 * as one; an accepted quote is an open invoice now and is named as an invoice.
 */
fun invoiceDocTitle(invoice: Invoice): String {
    val quote = isQuoteDraft(invoice) || invoice.status.trim().lowercase() == "quote"
    return "${if (quote) "Quote" else "Invoice"} #${invoice.invoiceNumber.ifBlank { "-" }}"
}

/** `details.code` when `createQuote` saved the quote as a draft but could not send it (#2087). */
const val QUOTE_SAVED_NOT_SENT_CODE: String = "quote_saved_not_sent"

/**
 * The saved quote's id from a refused `createQuote`, or null when the refusal is
 * anything else. The quote exists (a draft only the office sees), so the
 * composer closes onto it, as admin web's does, and a retry is Send quote on
 * that draft rather than a second press that would make a second quote. Pure.
 */
fun quoteSavedNotSentId(code: String?, details: String?): String? {
    if (code != QUOTE_SAVED_NOT_SENT_CODE || details.isNullOrBlank()) return null
    return runCatching {
        val obj = kotlinx.serialization.json.Json.parseToJsonElement(details) as? kotlinx.serialization.json.JsonObject
        (obj?.get("invoiceId") as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }
    }.getOrNull()
}

/** #2195: an archived quote, which the household cannot see until it is restored. */
fun isArchivedQuote(invoice: Invoice): Boolean =
    invoiceIsArchived(invoice) && (isQuoteDraft(invoice) || invoice.status.trim().lowercase() == "quote")

/** The notice after a quote saved unsent is sent, honest about where it went (#1511). */
fun quoteSentMessage(appOnly: Boolean): String =
    if (appOnly) "Quote sent in the app only. $APP_ONLY_NOTE The household can accept or decline it now."
    else "Quote sent. The household can accept or decline it now."

/** The confirm before a quote saved unsent is sent. */
const val SEND_QUOTE_CONFIRM_TEXT: String =
    "This sends the quote to the household, who can then accept or decline it. It is not a bill until they accept."

const val CONVERT_QUOTE_CONFIRM_TEXT: String =
    "This turns the quote into a draft invoice. It keeps its number, its lines and its visits, and any " +
        "answer from the household is cleared. The household sees nothing until you send the invoice with " +
        "Review and send."

const val WITHDRAW_QUOTE_CONFIRM_TEXT: String =
    "This withdraws the quote. The household no longer sees it, and the visits it holds go back on the " +
        "not yet invoiced list. It is kept as cancelled, not deleted."

const val QUOTE_CONVERTED_TEXT: String =
    "Quote turned into a draft invoice. Send it with Review and send when it is ready."

fun quoteWithdrawnText(released: Int): String = when {
    released <= 0 -> "Quote withdrawn. The household no longer sees it."
    released == 1 ->
        "Quote withdrawn. The household no longer sees it, and its visit is back on the not yet invoiced list."
    else ->
        "Quote withdrawn. The household no longer sees it, and its $released visits are back on the not yet invoiced list."
}

/** #2195: the household declined this quote (`quoteDecision` 'denied'). */
fun quoteDeclined(invoice: Invoice): Boolean =
    (invoice.quoteDecision as? JsonPrimitive)?.takeIf { it.isString }?.content == "denied"

/** #2195: the Archived notice on a sent quote nobody has answered. */
const val ARCHIVED_QUOTE_TEXT: String =
    "This quote is out of the working list. The household cannot see it or answer it until it is restored, " +
        "and the visits it held are back on the not yet invoiced list."

/** #2195: the Restore confirm on a sent quote nobody has answered. */
const val RESTORE_QUOTE_CONFIRM_TEXT: String =
    "This puts the quote back into the working list, and back in front of the household, who can answer it " +
        "again. It takes back the visits no other invoice has billed since. Continue?"

/**
 * #2195: the Archived notice on an archived quote. Only a SENT quote nobody
 * has answered goes back in front of the household to be answered; one saved
 * unsent was never shown to them, and a declined one holds no visits. Same
 * words as admin web and Android.
 */
fun archivedQuoteText(invoice: Invoice): String = when {
    isQuoteDraft(invoice) ->
        "This quote is out of the working list. It was never sent, so the household cannot see it, and the " +
            "visits it held are back on the not yet invoiced list."
    quoteDeclined(invoice) ->
        "This quote is out of the working list. The household cannot see it until it is restored."
    else -> ARCHIVED_QUOTE_TEXT
}

/** #2195: the Restore confirm on an archived quote, by the same three cases. */
fun restoreQuoteConfirmText(invoice: Invoice): String = when {
    isQuoteDraft(invoice) ->
        "This puts the quote back into the working list as a draft. The household still cannot see it until " +
            "you send it. It takes back the visits no other invoice has billed since. Continue?"
    quoteDeclined(invoice) ->
        "This puts the quote back into the working list. The household sees it again, as declined. Continue?"
    else -> RESTORE_QUOTE_CONFIRM_TEXT
}
