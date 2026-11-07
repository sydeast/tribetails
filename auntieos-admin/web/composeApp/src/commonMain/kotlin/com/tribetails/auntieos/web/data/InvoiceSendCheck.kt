package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * #1567: what the desktop console says when an invoice send got no answer.
 *
 * Twin of the web's `src/lib/invoiceSendCheck.ts` and Android's
 * `domain/InvoiceSendCheck.kt`; the sentences match word for word. A send can
 * run out of time here (90s, [AUNTIE_REQUEST_TIMEOUT_MS]) while the server goes
 * on to finish it, and the console used to print "Timed out reaching the
 * server. Check your connection and try again." over an invoice that had been
 * emailed. So the invoice is read before the send and again after a timeout,
 * and the mark each send leaves is compared:
 *
 *   REVIEW_SEND   status leaves `draft`
 *   REMINDER      `reminderNotifiedAtMs` moves
 *   RECEIPT       `receiptIssuedAt` moves
 *   RESEND_QUOTE  `quoteResentAt` moves
 *
 * The REST reader hands timestamps back as strings, so a stamp is compared as
 * the text it arrived as: before against after, never against a clock.
 */
enum class SendCheckAction { REVIEW_SEND, REMINDER, RECEIPT, RESEND_QUOTE }

data class SendMarks(
    val status: String,
    val reminderStamp: String?,
    val receiptStamp: String?,
    val quoteResentStamp: String?,
)

/** The console's budget for a send, in whole seconds, as the sentence names it. */
val SEND_BUDGET_SECONDS: Int = (AUNTIE_REQUEST_TIMEOUT_MS / 1000).toInt()

private fun JsonObject.stampOf(key: String): String? =
    (this[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() }

/** Reads the send marks off a plain invoice document. */
fun sendMarksOf(doc: JsonObject): SendMarks = SendMarks(
    status = doc.stampOf("status")?.trim()?.lowercase() ?: "",
    reminderStamp = doc.stampOf("reminderNotifiedAtMs"),
    receiptStamp = doc.stampOf("receiptIssuedAt"),
    quoteResentStamp = doc.stampOf("quoteResentAt"),
)

/** True when [after] carries the mark [action] leaves and [before] did not. */
fun sendLanded(action: SendCheckAction, before: SendMarks, after: SendMarks): Boolean = when (action) {
    SendCheckAction.REVIEW_SEND -> before.status == "draft" && after.status.isNotEmpty() && after.status != "draft"
    SendCheckAction.REMINDER -> after.reminderStamp != null && after.reminderStamp != before.reminderStamp
    SendCheckAction.RECEIPT -> after.receiptStamp != null && after.receiptStamp != before.receiptStamp
    SendCheckAction.RESEND_QUOTE -> after.quoteResentStamp != null && after.quoteResentStamp != before.quoteResentStamp
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

/** The sentence after a send got no answer. A null read is the one case that honestly cannot tell. */
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

/** What a send came back with: the server's answer, or a silence the console re-read. */
sealed interface CheckedSend<out T> {
    data class Answered<T>(val result: WriteResult<T>) : CheckedSend<T>
    data class Silent(val outcome: SilenceOutcome) : CheckedSend<Nothing>
}

/**
 * Runs [send] with the #1567 check around it. [readMarks] reads the invoice
 * from the server; it runs once before the send and, only when the send timed
 * out, once after. Any other error is the server answering and is passed
 * through untouched, so a refusal still reads verbatim.
 */
suspend fun <T> checkedSend(
    action: SendCheckAction,
    readMarks: suspend () -> SendMarks?,
    send: suspend () -> WriteResult<T>,
): CheckedSend<T> {
    val before = readMarks()
    val result = send()
    if (result is WriteResult.Err && result.message == AUNTIE_TIMEOUT_MESSAGE) {
        return CheckedSend.Silent(sendOutcomeAfterSilence(action, SEND_BUDGET_SECONDS, before, readMarks()))
    }
    return CheckedSend.Answered(result)
}
