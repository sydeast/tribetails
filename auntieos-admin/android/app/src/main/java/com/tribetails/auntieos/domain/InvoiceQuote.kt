package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Invoice

/**
 * #2087 / #2088 / #2195: what the office can do with a quote once it exists.
 * Pure, so every rule and sentence here is pinned by a unit test. The server
 * (`mytribe/functions/src/admin/quoteActions.ts`, `reviewAndSendDraftInvoice`)
 * is the enforcement; these decide only what the screen offers and says.
 */

/**
 * A quote saved with "Send to kinfolk now" off: a draft only the office sees,
 * whose send makes it a Quote rather than a bill. Its stamped state is DRAFT;
 * the `quoteDraft` mark is the difference.
 */
fun isQuoteDraft(invoice: Invoice): Boolean =
    invoice.quoteDraft == true && invoiceStateOrNull(invoice) == InvoiceState.DRAFT

/**
 * Whether the office can still turn this quote into an invoice or withdraw
 * it: a quote saved unsent, or a sent one the household has not accepted, and
 * not archived (an archived invoice is read-only until it is restored).
 */
fun quoteIsChangeable(invoice: Invoice): Boolean {
    if (invoiceIsArchived(invoice)) return false
    if (invoiceQuoteDecision(invoice) == QuoteDecision.ACCEPTED) return false
    return isQuoteDraft(invoice) || invoiceStateOrNull(invoice) == InvoiceState.QUOTE
}

/** The same, for an archived quote as it would be once restored (#2195). */
fun quoteIsChangeableOnRestore(invoice: Invoice): Boolean =
    quoteIsChangeable(invoice.copy(archivedAt = null))

/** The confirm before a quote saved unsent is sent. */
const val SEND_QUOTE_CONFIRM_COPY: String =
    "This sends the quote to the household, who can then accept or decline it. It is not a bill until they accept."

/** The toast after a quote saved unsent is sent (#2087), honest about where it went (#1511). */
fun quoteSentMessage(appOnly: Boolean): String =
    if (appOnly) "Quote sent in the app only. $APP_ONLY_NOTE The household can accept or decline it now."
    else "Quote sent. The household can accept or decline it now."

/** The confirm before a quote becomes a draft invoice (#2088). */
const val CONVERT_QUOTE_CONFIRM_COPY: String =
    "This turns the quote into a draft invoice. It keeps its number, its lines and its visits, and any " +
        "answer from the household is cleared. The household sees nothing until you send the invoice with " +
        "Review and send."

/** The confirm before a quote is withdrawn (#2088). */
const val WITHDRAW_QUOTE_CONFIRM_COPY: String =
    "This withdraws the quote. The household no longer sees it, and the visits it holds go back on the " +
        "not yet invoiced list. It is kept, marked cancelled, and is not deleted."

/** The toast once a quote is a draft invoice. */
const val QUOTE_CONVERTED_MESSAGE: String =
    "Quote turned into a draft invoice. Send it with Review and send when it is ready."

/** The toast once a quote is withdrawn, naming how many visits went back on the list. */
fun quoteWithdrawnMessage(released: Int): String = when {
    released <= 0 -> "Quote withdrawn. The household no longer sees it."
    released == 1 ->
        "Quote withdrawn. The household no longer sees it, and its visit is back on the not yet invoiced list."
    else ->
        "Quote withdrawn. The household no longer sees it, and its $released visits are back on the not yet invoiced list."
}

/** #2195: the archive confirm for a quote, which the household stops seeing. */
const val ARCHIVE_QUOTE_CONFIRM_COPY: String =
    "This takes the quote out of the working list. The household no longer sees it and cannot answer it, and " +
        "the visits it holds go back on the not yet invoiced list. It is not deleted, and Restore brings it back."

/** #2195: the restore confirm for a quote, which goes back in front of the household. */
const val RESTORE_QUOTE_CONFIRM_COPY: String =
    "This puts the quote back into the working list, and back in front of the household, who can answer it " +
        "again. It takes back the visits no other invoice has billed since."
