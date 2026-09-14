package com.tribetails.auntieos.web.data

import kotlinx.datetime.TimeZone
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/** #832: the console's reading of the sendInvoiceReminder answer, and the words it shows. */
class InvoiceReminderTest {

    private val t = 1_757_862_300_000L // 2025-09-14 15:05:00 UTC
    private val day = 24L * 60 * 60 * 1000

    @Test
    fun decodesASend() {
        assertEquals(
            ReminderOutcome(true, t, t + day),
            decodeReminderOutcome("""{"ok":true,"invoiceId":"i","sent":true,"lastReminderAtMs":$t,"nextReminderAllowedAtMs":${t + day}}""", 1L),
        )
    }

    @Test
    fun decodesAnAlreadySentAnswer() {
        assertEquals(
            ReminderOutcome(false, t, t + day),
            decodeReminderOutcome("""{"ok":true,"invoiceId":"i","sent":false,"lastReminderAtMs":$t,"nextReminderAllowedAtMs":${t + day}}""", 1L),
        )
    }

    @Test
    fun aBodyWithoutSentIsAPreFixSendNeverARefusal() {
        assertEquals(ReminderOutcome(true, 42L, 42L), decodeReminderOutcome("""{"ok":true,"invoiceId":"i"}""", 42L))
    }

    @Test
    fun malformedBodyThrows() {
        assertFailsWith<Exception> { decodeReminderOutcome("not-json{", 1L) }
    }

    @Test
    fun formatsMonthDayAndClockTime() {
        assertEquals("Sep 14, 3:05 PM", formatReminderTime(t, TimeZone.UTC))
    }

    @Test
    fun sentMessageIsPlain() {
        assertEquals("Reminder sent.", reminderOutcomeMessage(ReminderOutcome(true, t, t + day), TimeZone.UTC))
    }

    @Test
    fun refusedMessageSaysWhenAndWhenNext() {
        assertEquals(
            "Not sent: a reminder already went out Sep 14, 3:05 PM. The next one can go out after Sep 15, 3:05 PM.",
            reminderOutcomeMessage(ReminderOutcome(false, t, t + day), TimeZone.UTC),
        )
    }

    @Test
    fun lastReminderLabelReadsNoneSentForNullOrZero() {
        assertEquals("none sent", lastReminderLabel(null))
        assertEquals("none sent", lastReminderLabel(0L))
        assertEquals("Sep 14, 3:05 PM", lastReminderLabel(t, TimeZone.UTC))
    }
}
