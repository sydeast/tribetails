package com.tribetails.auntieos.web.screens.invoices

import com.tribetails.auntieos.web.data.APP_ONLY_NOTE
import com.tribetails.auntieos.web.data.Invoice

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

/** #2195: the Archived notice on a quote. */
const val ARCHIVED_QUOTE_TEXT: String =
    "This quote is out of the working list. The household cannot see it or answer it until it is restored, " +
        "and the visits it held are back on the not yet invoiced list."

/** #2195: the Restore confirm on a quote. */
const val RESTORE_QUOTE_CONFIRM_TEXT: String =
    "This puts the quote back into the working list, and back in front of the household, who can answer it " +
        "again. It takes back the visits no other invoice has billed since. Continue?"
