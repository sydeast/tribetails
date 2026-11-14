package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.contracts.HouseholdNoticeDto
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * #1816, #1838, #2027, #1841: the same vectors as web
 * `auntieos-admin/src/lib/householdNoticeWords.test.ts`, word for word.
 */
class HouseholdNoticeWordsTest {
    private fun ready(
        willNotify: Boolean = true,
        reason: String? = null,
        name: String? = "Dre East",
        channels: List<String> = listOf("email"),
    ) = HouseholdNoticePreview.Ready(willNotify, reason, name, channels)

    private fun notice(told: Boolean, reason: String? = null, channels: List<String> = emptyList()) =
        HouseholdNoticeDto(told = told, reason = reason, name = "Dre East", channels = channels)

    @Test fun channelWordsNamesEachChannel() {
        assertEquals("an email", channelWords(listOf("email")))
        assertEquals("an email and a text", channelWords(listOf("email", "sms")))
        assertEquals("an email, a text and a phone notification", channelWords(listOf("email", "sms", "push")))
        assertEquals("", channelWords(emptyList()))
    }

    @Test fun happyConfirmNamesWhoAndHow() {
        assertEquals("Dre East will get an email.", householdNoticeConfirmLine(ready(), "The Easts"))
        assertEquals(
            "Dre East will see it in their notifications list only.",
            householdNoticeConfirmLine(ready(channels = emptyList()), "The Easts"),
        )
    }

    @Test fun sadConfirmSaysWhyNobody() {
        fun line(reason: String) = householdNoticeConfirmLine(ready(willNotify = false, reason = reason, channels = emptyList()), "")
        assertEquals("Nobody will be told: Dre East has no portal account.", line("household_has_no_portal_account"))
        assertEquals("Nobody will be told: this notice is turned off for Dre East.", line("household_prefs_suppressed"))
        assertEquals("Nobody will be told: notices to households are off in Settings.", line("household_notices_off"))
        assertEquals("Nobody will be told: this visit is not linked to a booking.", line("session_has_no_routing_ids"))
        assertEquals("No notice goes to Dre East for this.", line("not_a_household_notice"))
    }

    @Test fun negativeAnAuntieIsNeverSentToSettings() {
        val line = householdNoticeConfirmLine(ready(willNotify = false, reason = "household_notices_off"), "", auntie = true)
        assertEquals("Nobody will be told: the owner has notices to households turned off.", line)
        assertFalse(line!!.contains("Settings"))
    }

    @Test fun negativeNameFallsBack() {
        assertEquals("The Easts will get an email.", householdNoticeConfirmLine(ready(name = null), "The Easts"))
        assertEquals("The household will get an email.", householdNoticeConfirmLine(ready(name = null), ""))
    }

    @Test fun errorCheckingAndUnknown() {
        assertEquals("Checking who will be told.", householdNoticeConfirmLine(HouseholdNoticePreview.Checking, "x"))
        assertNull(householdNoticeConfirmLine(HouseholdNoticePreview.Unknown, "x"))
        assertNull(householdNoticeConfirmLine(ready(willNotify = false, reason = "something_new"), "x"))
    }

    @Test fun resultLinesFromTheServer() {
        assertEquals(
            "Dre East was sent an email and a phone notification.",
            householdNoticeResultLine(notice(true, channels = listOf("email", "push")), ""),
        )
        assertEquals("Dre East was told in their notifications list only.", householdNoticeResultLine(notice(true), ""))
        assertEquals(
            "Nobody was told: notices to households are off in Settings.",
            householdNoticeResultLine(notice(false, "household_notices_off"), ""),
        )
        assertEquals("Dre East was already told about this.", householdNoticeResultLine(notice(false, "already_notified"), ""))
        assertEquals("No confirmation was sent.", householdNoticeResultLine(notice(false, "not_requested"), ""))
        assertEquals("The notice to Dre East could not be sent.", householdNoticeResultLine(notice(false, "dispatch_failed"), ""))
        assertEquals("Nobody was told.", householdNoticeResultLine(notice(false, "no_recipient"), ""))
    }

    @Test fun errorNoNoticeClaimsNothing() {
        assertEquals("", householdNoticeResultLine(null, "x"))
        assertEquals("Done.", withHouseholdLine("Done.", ""))
        assertEquals("Done. Nobody was told.", withHouseholdLine("Done.", "Nobody was told."))
    }

    @Test fun householdNoticeOfReadsTheWireShape() {
        assertEquals(
            HouseholdNoticeDto(true, null, "Dre East", listOf("email")),
            householdNoticeOf(mapOf("told" to true, "reason" to null, "name" to "Dre East", "channels" to listOf("email", 3))),
        )
        assertNull(householdNoticeOf(null))
        assertNull(householdNoticeOf(mapOf("reason" to "x")))
    }
}
/** #1841: the New Booking confirmation line. */
class NewVisitConfirmationLineTest {
    private val ready = HouseholdNoticePreview.Ready(true, null, "Dre East", listOf("email"))
    @Test fun offeredOnlyForAVisitConfirmedNowAndStillAhead() {
        assertNull(newVisitConfirmationLine(false, VisitWindowTiming.AHEAD, true, true, ready, ""))
        assertNull(newVisitConfirmationLine(true, VisitWindowTiming.ENDED, true, true, ready, ""))
        assertEquals("", newVisitConfirmationLine(true, VisitWindowTiming.AHEAD, false, true, ready, ""))
    }
    @Test fun saysWhatWillHappen() {
        assertEquals("Dre East will get an email.", newVisitConfirmationLine(true, VisitWindowTiming.AHEAD, true, true, ready, ""))
        assertEquals(
            "Nobody will be told about this visit.",
            newVisitConfirmationLine(true, VisitWindowTiming.AHEAD, true, false, ready, ""),
        )
    }
}
