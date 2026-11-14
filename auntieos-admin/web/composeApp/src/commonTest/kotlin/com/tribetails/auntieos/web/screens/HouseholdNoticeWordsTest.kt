package com.tribetails.auntieos.web.screens

import com.tribetails.auntieos.web.screens.kintales.kinTaleComposeSentMessage
import com.tribetails.auntieos.web.screens.kintales.kinTaleSendConfirmText
import com.tribetails.auntieos.web.screens.schedule.newVisitSummary
import com.tribetails.auntieos.web.screens.schedule.noteSavedToast
import com.tribetails.auntieos.web.screens.schedule.rescheduledToast
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * #1816, #1838, #2027, #1841: the desktop console's household-notice lines,
 * the same vectors as web `householdNoticeWords.test.ts` and Android
 * `HouseholdNoticeWordsTest` (the owner's wording only: the console is hers).
 */
class HouseholdNoticeWordsTest {
    private fun ready(willNotify: Boolean = true, reason: String? = null, channels: List<String> = listOf("email")) =
        HouseholdNoticePreview.Ready(willNotify, reason, "Dre East", channels)

    private fun notice(told: Boolean, reason: String? = null, channels: List<String> = emptyList()) =
        HouseholdNotice(told, reason, "Dre East", channels)

    @Test fun channelWordsNamesEachChannel() {
        assertEquals("an email, a text and a phone notification", channelWords(listOf("email", "sms", "push")))
        assertEquals("an email and a text", channelWords(listOf("email", "sms")))
    }

    @Test fun happyConfirmNamesWhoAndHow() {
        assertEquals("Dre East will get an email.", householdNoticeConfirmLine(ready(), ""))
        assertEquals("Dre East will see it in their notifications list only.", householdNoticeConfirmLine(ready(channels = emptyList()), ""))
    }

    @Test fun sadConfirmSaysWhyNobody() {
        fun line(reason: String) = householdNoticeConfirmLine(ready(false, reason, emptyList()), "")
        assertEquals("Nobody will be told: notices to households are off in Settings.", line("household_notices_off"))
        assertEquals("Nobody will be told: Dre East has no portal account.", line("household_has_no_portal_account"))
        assertEquals("Nobody will be told: this visit is not linked to a booking.", line("session_has_no_routing_ids"))
        assertEquals("No notice goes to Dre East for this.", line("not_a_household_notice"))
    }

    @Test fun errorCheckingAndUnknown() {
        assertEquals("Checking who will be told.", householdNoticeConfirmLine(HouseholdNoticePreview.Checking, ""))
        assertNull(householdNoticeConfirmLine(HouseholdNoticePreview.Unknown, ""))
    }

    @Test fun resultLinesFromTheServer() {
        assertEquals("Dre East was sent an email.", householdNoticeResultLine(notice(true, channels = listOf("email")), ""))
        assertEquals("Nobody was told: notices to households are off in Settings.", householdNoticeResultLine(notice(false, "household_notices_off"), ""))
        assertEquals("The notice to Dre East could not be sent.", householdNoticeResultLine(notice(false, "dispatch_failed"), ""))
        assertEquals("", householdNoticeResultLine(null, ""))
    }

    @Test fun parsesTheWireShapes() {
        val n = householdNoticeOf(Json.parseToJsonElement("""{"told":true,"reason":null,"name":"Dre East","channels":["email","sms"]}"""))
        assertEquals(HouseholdNotice(true, null, "Dre East", listOf("email", "sms")), n)
        assertNull(householdNoticeOf(Json.parseToJsonElement("""{"reason":"x"}""")))
        val p = householdPreviewOf(Json.parseToJsonElement("""{"ok":true,"willNotify":false,"reason":"household_notices_off","name":null,"channels":[]}""").jsonObject)
        assertEquals(HouseholdNoticePreview.Ready(false, "household_notices_off", null, emptyList()), p)
        // A server from before the key answers without channels: no answer.
        assertNull(householdPreviewOf(Json.parseToJsonElement("""{"ok":true,"willNotify":true,"reason":null}""").jsonObject))
    }

    @Test fun newVisitConfirmationLine() {
        assertNull(newVisitConfirmationLine(false, true, true, ready(), ""))
        assertEquals("", newVisitConfirmationLine(true, false, true, ready(), ""))
        assertEquals("Nobody will be told about this visit.", newVisitConfirmationLine(true, true, false, ready(), ""))
        assertEquals("Dre East will get an email.", newVisitConfirmationLine(true, true, true, ready(), ""))
    }

    @Test fun theToastsSayWhatTheServerDid() {
        assertEquals("Visit scheduled. Dre East was sent an email.", newVisitSummary(false, notice(true, channels = listOf("email")), "The Wrens"))
        assertEquals("Visit scheduled. No confirmation was sent.", newVisitSummary(false, notice(false, "not_requested"), "The Wrens"))
        assertEquals("Visit recorded as completed.", newVisitSummary(true, null, "The Wrens"))
        assertEquals("Visit scheduled.", newVisitSummary(false, null, "The Wrens"))
        assertEquals("The Wrens's visit is rescheduled. Dre East was sent an email.", rescheduledToast("The Wrens", notice(true, channels = listOf("email"))))
        assertEquals("The Wrens's visit is rescheduled.", rescheduledToast("The Wrens", null))
        assertEquals("Note saved. No notice went to Dre East for this.", noteSavedToast(ready(false, "not_a_household_notice", emptyList()), "The Wrens"))
        assertEquals("Note saved.", noteSavedToast(HouseholdNoticePreview.Unknown, "The Wrens"))
        assertEquals("KinTale sent. Nobody was told: Dre East has no portal account.", kinTaleComposeSentMessage(notice(false, "household_has_no_portal_account"), "The Wrens"))
        assertEquals("KinTale sent. Still checking whether The Wrens was told. The Activity Log will show it.", kinTaleComposeSentMessage(null, "The Wrens"))
        assertEquals("Send to The Wrens. Dre East will get an email. This cannot be undone.", kinTaleSendConfirmText("The Wrens", "Dre East will get an email."))
        assertEquals("Send to The Wrens. This cannot be undone.", kinTaleSendConfirmText("The Wrens", null))
    }
}
