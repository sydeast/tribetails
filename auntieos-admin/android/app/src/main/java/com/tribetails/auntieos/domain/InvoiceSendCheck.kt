package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.Invoice

/**
 * #1567: what to tell the operator when an invoice send got no answer.
 *
 * Twin of the web's `auntieos-admin/src/lib/invoiceSendCheck.ts`; the
 * sentences match word for word. A send (review and send, reminder, receipt,
 * quote resend) can run out of time on the client while the server goes on to
 * finish it. The walk that found this saw "Action failed" on the web while the
 * invoice was emailed. So after a silent failure the invoice is re-read from
 * the server and the mark each send leaves is compared with the mark it carried
 * before the press:
 *
 *   REVIEW_SEND   status leaves `draft` (the server flips it to `open`)
 *   REMINDER      `reminderNotifiedAtMs` moves
 *   RECEIPT       `receiptIssuedAt` moves
 *   RESEND_QUOTE  `quoteResentAt` moves
 *
 * Before against after, never against the phone clock, so a skewed clock
 * cannot change the answer. The callable budget on Android is the SDK's 70s,
 * longer than the server's 60s function timeout, so a re-read after it reads
 * what the server really did.
 */
enum class SendCheckAction { REVIEW_SEND, REMINDER, RECEIPT, RESEND_QUOTE }

data class SendMarks(
    val status: String,
    val reminderNotifiedAtMs: Long?,
    val receiptIssuedAtMs: Long?,
    val quoteResentAtMs: Long?,
)

/** The client budget for a send on Android: the Functions SDK default. */
const val SEND_BUDGET_SECONDS: Int = 70

private fun millisOf(raw: Any?): Long? = when (raw) {
    is Long -> raw
    is Int -> raw.toLong()
    is Double -> if (raw.isFinite()) raw.toLong() else null
    is com.google.firebase.Timestamp -> raw.toDate().time
    is java.util.Date -> raw.time
    else -> null
}

/** Reads the send marks off a raw invoice document map. */
fun sendMarksOf(raw: Map<String, Any?>): SendMarks = SendMarks(
    status = (raw["status"] as? String)?.trim()?.lowercase() ?: "",
    reminderNotifiedAtMs = millisOf(raw["reminderNotifiedAtMs"]),
    receiptIssuedAtMs = millisOf(raw["receiptIssuedAt"]),
    quoteResentAtMs = millisOf(raw["quoteResentAt"]),
)

/**
 * The marks the loaded model can vouch for. The model carries no receipt or
 * quote-resend stamp, so a caller checking those sends reads the "before"
 * marks from the server instead ([com.tribetails.auntieos.data.repository.InvoiceRepository.readInvoiceSendMarks]).
 */
fun sendMarksOf(invoice: Invoice): SendMarks = SendMarks(
    status = invoice.status.trim().lowercase(),
    reminderNotifiedAtMs = invoice.reminderNotifiedAtMs,
    receiptIssuedAtMs = null,
    quoteResentAtMs = null,
)

/** True when [after] carries the mark [action] leaves and [before] did not. */
fun sendLanded(action: SendCheckAction, before: SendMarks, after: SendMarks): Boolean = when (action) {
    SendCheckAction.REVIEW_SEND ->
        before.status == "draft" && after.status.isNotEmpty() && after.status != "draft"
    SendCheckAction.REMINDER ->
        after.reminderNotifiedAtMs != null && after.reminderNotifiedAtMs != before.reminderNotifiedAtMs
    SendCheckAction.RECEIPT ->
        after.receiptIssuedAtMs != null && after.receiptIssuedAtMs != before.receiptIssuedAtMs
    SendCheckAction.RESEND_QUOTE ->
        after.quoteResentAtMs != null && after.quoteResentAtMs != before.quoteResentAtMs
}

private data class SendWords(val sent: String, val thing: String, val notSent: String, val check: String)

private fun wordsFor(action: SendCheckAction): SendWords = when (action) {
    SendCheckAction.REVIEW_SEND -> SendWords(
        sent = "Draft sent.",
        thing = "the draft",
        notSent = "The invoice is still a draft, so it has not gone out. Send it again.",
        check = "Reopen the invoice: Open means it went, Draft means it did not.",
    )
    SendCheckAction.REMINDER -> SendWords(
        sent = "Reminder sent.",
        thing = "the reminder",
        notSent = "No new reminder is on the invoice, so it has not gone out. Send it again.",
        check = "Check Last reminder on the invoice before sending another.",
    )
    SendCheckAction.RECEIPT -> SendWords(
        sent = "Receipt issued.",
        thing = "the receipt",
        notSent = "No new receipt is on the invoice, so it has not gone out. Issue it again.",
        check = "Reopen the invoice and check for the receipt before issuing another.",
    )
    SendCheckAction.RESEND_QUOTE -> SendWords(
        sent = "Quote sent again. The household can accept or decline it now.",
        thing = "the quote",
        notSent = "The quote has not been sent again. Send it again.",
        check = "Reopen the quote and check whether it is waiting on the household before sending it again.",
    )
}

enum class SilenceKind { SENT, NOT_SENT, UNKNOWN }

data class SilenceOutcome(val kind: SilenceKind, val message: String)

/**
 * The sentence after a send got no answer. [before] or [after] is null when
 * that read failed, which is the one case where the app honestly cannot tell.
 */
fun sendOutcomeAfterSilence(
    action: SendCheckAction,
    seconds: Int,
    before: SendMarks?,
    after: SendMarks?,
): SilenceOutcome {
    val words = wordsFor(action)
    val late = "Tribe Tails did not answer within $seconds seconds"
    if (before == null || after == null) {
        return SilenceOutcome(
            SilenceKind.UNKNOWN,
            "$late, and the invoice could not be re-read, so there is no way to tell from here whether ${words.thing} went. ${words.check}",
        )
    }
    if (sendLanded(action, before, after)) {
        return SilenceOutcome(
            SilenceKind.SENT,
            "${words.sent} The answer came late, so this was confirmed by re-reading the invoice.",
        )
    }
    return SilenceOutcome(SilenceKind.NOT_SENT, "$late. ${words.notSent}")
}
