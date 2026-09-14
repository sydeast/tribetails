package com.tribetails.auntieos.domain

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * What the server decided when the admin asked for an invoice reminder (#832).
 *
 * `sendInvoiceReminder` refuses a second reminder inside its window and answers
 * `sent = false` with the time of the one that already went out. That is a
 * success: the household has been reminded. The app says so, and when, instead
 * of "Reminder sent." for a send that did not happen.
 */
data class ReminderOutcome(
    /** True when THIS call sent a reminder. */
    val sent: Boolean,
    /** When the most recent reminder went out (ms epoch). */
    val lastReminderAtMs: Long,
    /** The earliest moment another reminder will be accepted (ms epoch). */
    val nextReminderAllowedAtMs: Long,
)

/** "Sep 14, 3:05 PM", in [zone] (the device's own zone unless a test pins one). */
fun formatReminderTime(ms: Long, zone: TimeZone = TimeZone.getDefault()): String =
    SimpleDateFormat("MMM d, h:mm a", Locale.US).apply { timeZone = zone }.format(Date(ms))

/** The toast or banner line after a press. */
fun reminderOutcomeMessage(outcome: ReminderOutcome, zone: TimeZone = TimeZone.getDefault()): String =
    if (outcome.sent) {
        "Reminder sent."
    } else {
        "Not sent: a reminder already went out ${formatReminderTime(outcome.lastReminderAtMs, zone)}. " +
            "The next one can go out after ${formatReminderTime(outcome.nextReminderAllowedAtMs, zone)}."
    }

/** The value of the "Last reminder" row. Absent, null or non-positive means none on record. */
fun lastReminderLabel(stampMs: Long?, zone: TimeZone = TimeZone.getDefault()): String =
    if (stampMs != null && stampMs > 0L) formatReminderTime(stampMs, zone) else "none sent"
