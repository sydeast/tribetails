package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.repository.reminderOutcomeOf
import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.TimeZone

/** #832: the app's reading of the sendInvoiceReminder answer, and the words it shows. */
class InvoiceReminderTest {

    private val utc = TimeZone.getTimeZone("UTC")
    private val t = 1_757_862_300_000L // 2025-09-14 15:05:00 UTC
    private val day = 24L * 60 * 60 * 1000

    @Test
    fun `decodes a send`() {
        assertEquals(
            ReminderOutcome(true, "sent", t, t + day),
            reminderOutcomeOf(mapOf("ok" to true, "invoiceId" to "i", "sent" to true, "reason" to "sent", "lastReminderAtMs" to t, "nextReminderAllowedAtMs" to t + day), 1L),
        )
    }

    @Test
    fun `decodes an already-sent answer, numbers arriving as Int or Long`() {
        assertEquals(
            ReminderOutcome(false, "recent", 500L, 86_400_500L),
            reminderOutcomeOf(mapOf("ok" to true, "sent" to false, "reason" to "recent", "lastReminderAtMs" to 500, "nextReminderAllowedAtMs" to 86_400_500L), 1L),
        )
    }

    @Test
    fun `decodes suppressed and in-progress with null times`() {
        assertEquals(
            ReminderOutcome(false, "suppressed", null, null),
            reminderOutcomeOf(mapOf("ok" to true, "sent" to false, "reason" to "suppressed", "lastReminderAtMs" to null, "nextReminderAllowedAtMs" to null), 1L),
        )
        assertEquals(
            ReminderOutcome(false, "in-progress", null, t),
            reminderOutcomeOf(mapOf("ok" to true, "sent" to false, "reason" to "in-progress", "nextReminderAllowedAtMs" to t), 1L),
        )
    }

    @Test
    fun `an answer without sent is a pre-fix send, never a refusal`() {
        // The generated decoder alone would read this as sent = false.
        assertEquals(ReminderOutcome(true, "sent", 42L, null), reminderOutcomeOf(mapOf("ok" to true, "invoiceId" to "i"), 42L))
        assertEquals(ReminderOutcome(true, "sent", 42L, null), reminderOutcomeOf(null, 42L))
    }

    @Test
    fun `formats month, day and clock time`() {
        assertEquals("Sep 14, 3:05 PM", formatReminderTime(t, utc))
    }

    @Test
    fun `each reason reads as its own sentence`() {
        assertEquals("Reminder sent.", reminderOutcomeMessage(ReminderOutcome(true, "sent", t, t + day), utc))
        assertEquals(
            "Not sent: a reminder already went out Sep 14, 3:05 PM. The next one can go out after Sep 15, 3:05 PM.",
            reminderOutcomeMessage(ReminderOutcome(false, "recent", t, t + day), utc),
        )
        assertEquals(
            "Not sent: a reminder for this invoice is already being sent. If it does not arrive, try again after Sep 14, 3:05 PM.",
            reminderOutcomeMessage(ReminderOutcome(false, "in-progress", null, t), utc),
        )
        assertEquals(
            "Not sent: this household's notification settings block payment reminders, so no reminder went out.",
            reminderOutcomeMessage(ReminderOutcome(false, "suppressed", null, null), utc),
        )
    }

    @Test
    fun `last reminder label reads none sent for null or zero`() {
        assertEquals("none sent", lastReminderLabel(null))
        assertEquals("none sent", lastReminderLabel(0L))
        assertEquals("Sep 14, 3:05 PM", lastReminderLabel(t, utc))
    }
}
