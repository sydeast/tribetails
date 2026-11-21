package com.tribetails.auntieos.web.screens.communicate

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
/**
 * #2316 (operator ruling 2026-11-20): a household with no MyTribe account is
 * texted the whole message. The vectors are the server's
 * `householdWholeSms.test.ts` and the web admin's `lib/householdText.test.ts`,
 * so every confirm splits where the send splits.
 */
class HouseholdWholeTextTest {
    @Test
    fun oneTextCarriesWhatTheServerSendsInOne() {
        assertEquals(1600, SMS_BODY_MAX)
    }
    @Test
    fun aMessageThatFitsIsOneTextAsWrittenTrimmedWithNoCutAndNoLink() {
        assertEquals(listOf("Closed Monday.\nBack Tuesday."), householdWholeTextParts("  Closed Monday.\nBack Tuesday.  "))
    }
    @Test
    fun aLongMessageIsSplitAtTheEndOfAWordAndNothingIsLost() {
        val text = "word ".repeat(30) + "end"
        val parts = householdWholeTextParts(text, 40)
        assertTrue(parts.all { it.length <= 40 })
        assertEquals(text, parts.joinToString(" "))
        assertTrue(parts.none { it.startsWith(" ") || it.endsWith(" ") })
    }
    @Test
    fun aRunWithNoSpaceNearTheLimitIsCutWhereItFitsNeverInsideACharacter() {
        val dog = "🐕"
        val text = "a".repeat(30) + dog + "b".repeat(30)
        val parts = householdWholeTextParts(text, 31)
        assertTrue(parts.all { it.length <= 31 })
        assertEquals(text, parts.joinToString(""))
        assertTrue(parts.any { it.contains(dog) })
    }
    @Test
    fun splitsAtThe1600LimitByDefault() {
        val text = "Nova ran and ran. ".repeat(120) + "The end."
        val parts = householdWholeTextParts(text)
        assertEquals(2, parts.size)
        assertTrue(parts[0].length <= 1600 && parts[0].length > 1280)
        assertEquals(text, parts.joinToString(" "))
    }
    @Test
    fun negativeABlankMessageIsNoTextAtAll() {
        assertEquals(emptyList<String>(), householdWholeTextParts("   "))
    }
    @Test
    fun noPortalAccountIsTheOneAnswerThatMeansTheWholeMessage() {
        assertEquals(HouseholdTextAccount.NoAccount, householdTextAccountOfReason("household_has_no_portal_account"))
        assertEquals(HouseholdTextAccount.Account, householdTextAccountOfReason(null))
        assertEquals(HouseholdTextAccount.Account, householdTextAccountOfReason("household_notices_off"))
    }
    @Test
    fun withAnAccountTheShortLineAndTheLink() {
        val body = "See you Friday at 9.\nGate code is the usual."
        assertEquals(HouseholdTextAsSent.Short(householdTextPreviewLine(body)), householdTextAsSent(body, HouseholdTextAccount.Account))
        assertEquals(listOf("Text: ${householdTextPreviewLine(body)}"), householdTextAsSentLines(body, HouseholdTextAccount.Account))
    }
    @Test
    fun withoutOneTheWholeMessageLineBreaksKept() {
        val body = "See you Friday at 9.\nGate code is the usual."
        assertEquals(HouseholdTextAsSent.Whole(listOf(body)), householdTextAsSent(body, HouseholdTextAccount.NoAccount))
        assertEquals(listOf("Text: $body"), householdTextAsSentLines(body, HouseholdTextAccount.NoAccount))
    }
    @Test
    fun aWholeMessageOverOneTextIsShownAsTheTextsItGoesAs() {
        val text = "Nova ran and ran. ".repeat(120) + "The end."
        val lines = householdTextAsSentLines(text, HouseholdTextAccount.NoAccount)
        assertEquals(3, lines.size)
        assertEquals("Text, sent as 2 texts:", lines[0])
        assertTrue(lines[1].startsWith("1 of 2: Nova ran and ran."))
        assertTrue(lines[2].startsWith("2 of 2: ") && lines[2].endsWith("The end."))
    }
    @Test
    fun notKnownYetOrNotKnownAtAllClaimsNeither() {
        val body = "See you Friday at 9."
        assertEquals(HouseholdTextAsSent.Checking, householdTextAsSent(body, HouseholdTextAccount.Checking))
        assertEquals(HouseholdTextAsSent.Unknown, householdTextAsSent(body, HouseholdTextAccount.Unknown))
        val unknown = householdTextAsSentLines(body, HouseholdTextAccount.Unknown)
        assertTrue(unknown.none { it.contains("More in MyTribe") })
        assertEquals("Message: $body", unknown.last())
        assertTrue(householdTextAsSentLines(body, HouseholdTextAccount.Checking).single().startsWith("Text: Checking"))
    }
    @Test
    fun theChannelLineOnlySaysShortOrWholeOnceItIsKnown() {
        assertEquals("Text, kept short, with a link to MyTribe", householdTextChannelLine(HouseholdTextAccount.Account))
        assertEquals("Text, the whole message, because they have no MyTribe account", householdTextChannelLine(HouseholdTextAccount.NoAccount))
        assertEquals("Text", householdTextChannelLine(HouseholdTextAccount.Checking))
        assertEquals("Text", householdTextChannelLine(HouseholdTextAccount.Unknown))
    }
}
