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
    fun `#1507 decodes an app-only send, and only an explicit true`() {
        assertEquals(
            ReminderOutcome(true, "sent", t, t + day, appOnly = true),
            reminderOutcomeOf(mapOf("ok" to true, "sent" to true, "reason" to "sent", "lastReminderAtMs" to t, "nextReminderAllowedAtMs" to t + day, "appOnly" to true), 1L),
        )
        // A server from before #1507 omits the key: a channel send, as always.
        assertEquals(
            false,
            reminderOutcomeOf(mapOf("ok" to true, "sent" to true, "reason" to "sent", "lastReminderAtMs" to t, "nextReminderAllowedAtMs" to t + day), 1L).appOnly,
        )
        assertEquals(false, reminderOutcomeOf(mapOf("ok" to true, "sent" to true, "appOnly" to "yes"), 1L).appOnly)
        assertEquals(false, reminderOutcomeOf(null, 42L).appOnly)
    }

    @Test
    fun `#1507 an app-only send says where it went and what is off`() {
        assertEquals(
            "Reminder sent in the app only. Email and text are off for this household.",
            reminderOutcomeMessage(ReminderOutcome(true, "sent", t, t + day, appOnly = true), utc),
        )
        assertEquals(
            "Quote sent again, in the app only. Email and text are off for this household. The household can accept or decline it now.",
            quoteResentMessage(appOnly = true),
        )
        assertEquals("Quote sent again. The household can accept or decline it now.", quoteResentMessage(appOnly = false))
    }

    @Test
    fun `#1507 last reminder label says app only for an explicit true flag alone`() {
        assertEquals("Sep 14, 3:05 PM, app only", lastReminderLabel(t, utc, appOnly = true))
        assertEquals("Sep 14, 3:05 PM", lastReminderLabel(t, utc, appOnly = false))
        assertEquals("Sep 14, 3:05 PM", lastReminderLabel(t, utc, appOnly = null))
        assertEquals("none sent", lastReminderLabel(null, utc, appOnly = true))
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

    // ── #1511: the four more send results ─────────────────────────────────────
    @Test
    fun `draft, receipt and created-quote messages say where the notice went`() {
        assertEquals("Draft sent.", draftSentMessage(appOnly = false))
        assertEquals("Draft sent in the app only. Email and text are off for this household.", draftSentMessage(appOnly = true))
        assertEquals("Receipt generated.", receiptGeneratedMessage(appOnly = false))
        assertEquals("Receipt generated in the app only. Email and text are off for this household.", receiptGeneratedMessage(appOnly = true))
        assertEquals("Quote created.", quoteCreatedMessage(sent = false, appOnly = false))
        // An unsent quote has no delivery to describe, whatever the flag says.
        assertEquals("Quote created.", quoteCreatedMessage(sent = false, appOnly = true))
        assertEquals("Quote created and sent.", quoteCreatedMessage(sent = true, appOnly = false))
        assertEquals(
            "Quote created and sent in the app only. Email and text are off for this household.",
            quoteCreatedMessage(sent = true, appOnly = true),
        )
    }
}
