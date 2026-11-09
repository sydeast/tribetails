package com.tribetails.auntieos.domain

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * What the server decided when the admin asked for an invoice reminder (#832).
 *
 * Only [sent] means a reminder went out now. [reason] names the other three,
 * none of which is an error: `recent` (one already went out inside the
 * window), `in-progress` (another press is sending one right now), and
 * `suppressed` (the household's notification settings block reminders).
 *
 * #1507: [sent] with [appOnly] means the reminder reached the household in the
 * app only. Since #1505 a household that turned off every delivery channel
 * still gets the record in their notifications list, and nothing is emailed or
 * texted. "Reminder sent." alone would read as an email that does not exist,
 * so the sentence says where it went.
 */
data class ReminderOutcome(
    /** True when THIS call sent a reminder. */
    val sent: Boolean,
    /** `sent`, `recent`, `in-progress` or `suppressed`. */
    val reason: String,
    /** When a reminder last actually went out (ms epoch), or null if none ever did. */
    val lastReminderAtMs: Long?,
    /** The earliest moment a press can send again (ms epoch), or null when waiting would not help. */
    val nextReminderAllowedAtMs: Long?,
    /** With [sent]: the reminder reached the household in the app only (#1507). Absent from an older server reads false. */
    val appOnly: Boolean = false,
)

/** The four reasons the server answers with. */
val REMINDER_REASONS: Set<String> = setOf("sent", "recent", "in-progress", "suppressed")

/** #1507: the clause every app-only send carries, on every admin surface. */
const val APP_ONLY_NOTE = "Email and text are off for this household."

/** The toast after a declined quote is revised and sent again (#448), honest about where it went (#1507). */
fun quoteResentMessage(appOnly: Boolean): String =
    if (appOnly) "Quote sent again, in the app only. $APP_ONLY_NOTE The household can accept or decline it now."
    else "Quote sent again. The household can accept or decline it now."

/** The toast after a draft invoice is reviewed and sent, honest about where it went (#1511). */
fun draftSentMessage(appOnly: Boolean): String =
    if (appOnly) "Draft sent in the app only. $APP_ONLY_NOTE" else "Draft sent."

/** The toast after a receipt is issued, honest about where its notice went (#1511). */
fun receiptGeneratedMessage(appOnly: Boolean): String =
    if (appOnly) "Receipt generated in the app only. $APP_ONLY_NOTE" else "Receipt generated."

/**
 * The list's confirmation after a quote is created (#1511). [sent] is the
 * composer's send-to-household toggle; [appOnly] is the server's word that the
 * copy it sent reached the household in the app only, read only with [sent].
 */
fun quoteCreatedMessage(sent: Boolean, appOnly: Boolean): String = when {
    !sent -> "Quote created."
    appOnly -> "Quote created and sent in the app only. $APP_ONLY_NOTE"
    else -> "Quote created and sent."
}

/**
 * #1511: the clause appended to the payment toast when the household's
 * confirmation was written to their notifications list with nothing emailed,
 * texted or pushed. Said in place of "the confirmation email did not go out",
 * which would be the wrong claim: the record exists.
 */
const val PAYMENT_CONFIRMATION_APP_ONLY_NOTE =
    " The confirmation reached the household in the app only. $APP_ONLY_NOTE"

/**
 * "Sep 14, 3:05 PM", or "Sep 14, 2025, 3:05 PM" when it is not [nowMs]'s year
 * (#1599), in [zone] (the device's own zone unless a test pins one).
 */
fun formatReminderTime(ms: Long, zone: TimeZone = TimeZone.getDefault(), nowMs: Long = System.currentTimeMillis()): String {
    val year = SimpleDateFormat("yyyy", Locale.US).apply { timeZone = zone }
    val pattern = if (year.format(Date(ms)) == year.format(Date(nowMs))) "MMM d, h:mm a" else "MMM d, yyyy, h:mm a"
    return SimpleDateFormat(pattern, Locale.US).apply { timeZone = zone }.format(Date(ms))
}

/** The toast or banner line after a press. */
fun reminderOutcomeMessage(
    outcome: ReminderOutcome,
    zone: TimeZone = TimeZone.getDefault(),
    nowMs: Long = System.currentTimeMillis(),
): String {
    val next = outcome.nextReminderAllowedAtMs
    val last = outcome.lastReminderAtMs
    return when (outcome.reason) {
        "sent" -> if (outcome.appOnly) "Reminder sent in the app only. $APP_ONLY_NOTE" else "Reminder sent."
        "in-progress" ->
            "Not sent: a reminder for this invoice is already being sent." +
                (next?.let { " If it does not arrive, try again after ${formatReminderTime(it, zone, nowMs)}." } ?: "")
        "suppressed" ->
            "Not sent: this household's notification settings block payment reminders, so no reminder went out."
        else ->
            (last?.let { "Not sent: a reminder already went out ${formatReminderTime(it, zone, nowMs)}." }
                ?: "Not sent: a reminder already went out recently.") +
                (next?.let { " The next one can go out after ${formatReminderTime(it, zone, nowMs)}." } ?: "")
    }
}

/**
 * The value of the "Last reminder" row. Absent, null or non-positive means none on record.
 *
 * #1507: [appOnly] is the companion flag the server writes beside the stamp
 * (`reminderNotifiedAppOnly`). Only an explicit true adds "app only"; a stamp
 * from before the flag existed, or one copied from the dedupe ledger, has none.
 */
fun lastReminderLabel(
    stampMs: Long?,
    zone: TimeZone = TimeZone.getDefault(),
    appOnly: Boolean? = false,
    nowMs: Long = System.currentTimeMillis(),
): String =
    if (stampMs != null && stampMs > 0L) formatReminderTime(stampMs, zone, nowMs) + (if (appOnly == true) ", app only" else "")
    else "none sent"
