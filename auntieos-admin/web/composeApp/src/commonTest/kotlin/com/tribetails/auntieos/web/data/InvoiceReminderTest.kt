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
            ReminderOutcome(true, "sent", t, t + day),
            decodeReminderOutcome("""{"ok":true,"invoiceId":"i","sent":true,"reason":"sent","lastReminderAtMs":$t,"nextReminderAllowedAtMs":${t + day}}""", 1L),
        )
    }

    @Test
    fun decodesAnAppOnlySendAndOnlyAnExplicitTrue() {
        // #1507
        assertEquals(
            ReminderOutcome(true, "sent", t, t + day, appOnly = true),
            decodeReminderOutcome("""{"ok":true,"invoiceId":"i","sent":true,"reason":"sent","lastReminderAtMs":$t,"nextReminderAllowedAtMs":${t + day},"appOnly":true}""", 1L),
        )
        // A server from before #1507 omits the key: a channel send, as always.
        assertEquals(false, decodeReminderOutcome("""{"ok":true,"sent":true,"reason":"sent","lastReminderAtMs":$t,"nextReminderAllowedAtMs":null}""", 1L).appOnly)
        assertEquals(false, decodeReminderOutcome("""{"ok":true,"invoiceId":"i"}""", 42L).appOnly)
    }

    @Test
    fun appOnlySendSaysWhereItWentAndWhatIsOff() {
        // #1507
        assertEquals(
            "Reminder sent in the app only. Email and text are off for this household.",
            reminderOutcomeMessage(ReminderOutcome(true, "sent", t, t + day, appOnly = true), TimeZone.UTC),
        )
    }

    @Test
    fun lastReminderLabelSaysAppOnlyForAnExplicitTrueFlagAlone() {
        // #1507
        assertEquals("Sep 14, 3:05 PM, app only", lastReminderLabel(t, TimeZone.UTC, appOnly = true))
        assertEquals("Sep 14, 3:05 PM", lastReminderLabel(t, TimeZone.UTC, appOnly = false))
        assertEquals("Sep 14, 3:05 PM", lastReminderLabel(t, TimeZone.UTC, appOnly = null))
        assertEquals("none sent", lastReminderLabel(null, TimeZone.UTC, appOnly = true))
    }

    @Test
    fun decodesAnAlreadySentAnswer() {
        assertEquals(
            ReminderOutcome(false, "recent", t, t + day),
            decodeReminderOutcome("""{"ok":true,"invoiceId":"i","sent":false,"reason":"recent","lastReminderAtMs":$t,"nextReminderAllowedAtMs":${t + day}}""", 1L),
        )
    }

    @Test
    fun decodesSuppressedAndInProgressWithNullTimes() {
        assertEquals(
            ReminderOutcome(false, "suppressed", null, null),
            decodeReminderOutcome("""{"ok":true,"invoiceId":"i","sent":false,"reason":"suppressed","lastReminderAtMs":null,"nextReminderAllowedAtMs":null}""", 1L),
        )
        assertEquals(
            ReminderOutcome(false, "in-progress", null, t),
            decodeReminderOutcome("""{"ok":true,"invoiceId":"i","sent":false,"reason":"in-progress","lastReminderAtMs":null,"nextReminderAllowedAtMs":$t}""", 1L),
        )
    }

    @Test
    fun aBodyWithoutSentIsAPreFixSendNeverARefusal() {
        assertEquals(ReminderOutcome(true, "sent", 42L, null), decodeReminderOutcome("""{"ok":true,"invoiceId":"i"}""", 42L))
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
        assertEquals("Reminder sent.", reminderOutcomeMessage(ReminderOutcome(true, "sent", t, t + day), TimeZone.UTC))
    }

    @Test
    fun refusedMessageSaysWhenAndWhenNext() {
        assertEquals(
            "Not sent: a reminder already went out Sep 14, 3:05 PM. The next one can go out after Sep 15, 3:05 PM.",
            reminderOutcomeMessage(ReminderOutcome(false, "recent", t, t + day), TimeZone.UTC),
        )
    }

    @Test
    fun inProgressAndSuppressedMessages() {
        assertEquals(
            "Not sent: a reminder for this invoice is already being sent. If it does not arrive, try again after Sep 14, 3:05 PM.",
            reminderOutcomeMessage(ReminderOutcome(false, "in-progress", null, t), TimeZone.UTC),
        )
        assertEquals(
            "Not sent: this household's notification settings block payment reminders, so no reminder went out.",
            reminderOutcomeMessage(ReminderOutcome(false, "suppressed", null, null), TimeZone.UTC),
        )
    }

    @Test
    fun lastReminderLabelReadsNoneSentForNullOrZero() {
        assertEquals("none sent", lastReminderLabel(null))
        assertEquals("none sent", lastReminderLabel(0L))
        assertEquals("Sep 14, 3:05 PM", lastReminderLabel(t, TimeZone.UTC))
    }

    // ── #1511: the four more send results ─────────────────────────────────────

    @Test
    fun sendAckDecodesTheAppOnlyFlagAndOnlyAnExplicitTrue() {
        assertEquals(SendAck(appOnly = true), decodeSendAck("""{"ok":true,"appOnly":true}"""))
        assertEquals(SendAck(appOnly = false), decodeSendAck("""{"ok":true,"appOnly":false}"""))
        // A bare ack, from an older function or a call that wrote no household copy.
        assertEquals(SendAck(appOnly = false), decodeSendAck("""{"ok":true}"""))
        assertEquals(SendAck(appOnly = false), decodeSendAck("""{"ok":true,"invoiceId":"inv1"}"""))
    }

    @Test
    fun createdInvoiceDecodesTheIdAndTheFlag() {
        assertEquals(CreatedInvoice("q1", appOnly = true), decodeCreatedInvoice("""{"ok":true,"invoiceId":"q1","appOnly":true}"""))
        assertEquals(CreatedInvoice("inv1", appOnly = false), decodeCreatedInvoice("""{"ok":true,"invoiceId":"inv1"}"""))
        // A body with no id decodes to a blank id, as the callers always read it.
        assertEquals(CreatedInvoice("", appOnly = false), decodeCreatedInvoice("""{"ok":true}"""))
        assertFailsWith<Exception> { decodeCreatedInvoice("not-json{") }
    }

    @Test
    fun invoiceReceiptAndCreatedQuoteMessagesSayWhereTheNoticeWent() {
        assertEquals("Invoice sent.", invoiceSentMessage(appOnly = false))
        assertEquals("Invoice sent in the app only. Email and text are off for this household.", invoiceSentMessage(appOnly = true))
        assertEquals("Receipt generated.", receiptGeneratedMessage(appOnly = false))
        assertEquals("Receipt generated in the app only. Email and text are off for this household.", receiptGeneratedMessage(appOnly = true))
        assertEquals("Quote saved as a draft. The household cannot see it until you send it.", quoteCreatedMessage(sent = false, appOnly = false))
        // An unsent quote has no delivery to describe, whatever the flag says.
        assertEquals("Quote saved as a draft. The household cannot see it until you send it.", quoteCreatedMessage(sent = false, appOnly = true))
        assertEquals("Quote created and sent.", quoteCreatedMessage(sent = true, appOnly = false))
        assertEquals(
            "Quote created and sent in the app only. Email and text are off for this household.",
            quoteCreatedMessage(sent = true, appOnly = true),
        )
    }
}
