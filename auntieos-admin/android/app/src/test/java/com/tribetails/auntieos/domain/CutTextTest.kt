package com.tribetails.auntieos.domain

import com.tribetails.auntieos.ui.communicate.summaryLine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** #2323: a cut never ends on part of a character. */
class CutTextTest {
    // Written as escapes so the invisible parts can be read here.
    private val dog = "\uD83D\uDC15" // U+1F415, two units
    private val family = "\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67" // man, joiner, woman, joiner, girl
    private val womanDog = "\uD83D\uDC69\uD83C\uDFFD\u200D\uD83E\uDDAE" // woman, skin tone, joiner, guide dog
    private val flag = "\uD83C\uDDFA\uD83C\uDDF8" // regional letters U and S
    private val heart = "\u2764\uFE0F" // heart and its emoji style mark
    private val keycap = "1\uFE0F\u20E3" // digit, style mark, keycap
    private val accented = "e\u0301" // e and a combining acute accent

    @Test
    fun textThatFitsIsLeftAloneAndPlainTextIsCutAtTheLimit() {
        assertEquals("hello", cutWhole("hello", 5))
        assertEquals("", cutWhole("", 3))
        assertEquals("abcd", cutWhole("abcdef", 4))
    }

    @Test
    fun stepsBackOverAnEmojiTheLimitFallsInside() {
        assertEquals("a".repeat(59), cutWhole("a".repeat(59) + dog + " tail", 60))
        assertEquals("a".repeat(58) + dog, cutWhole("a".repeat(58) + dog + " tail", 60))
    }

    @Test
    fun neverKeepsPartOfAJoinedEmojiAFlagOrAMarkedCharacter() {
        for (glyph in listOf(family, womanDog, flag, heart, keycap, accented)) {
            for (lead in (60 - glyph.length + 1) until 60) {
                assertEquals("lead $lead in $glyph", "a".repeat(lead), cutWhole("a".repeat(lead) + glyph + " more", 60))
            }
            val exact = "a".repeat(60 - glyph.length) + glyph
            assertEquals(exact, cutWhole("$exact more", 60))
        }
    }

    @Test
    fun twoFlagsInARowSplitOnlyBetweenThem() {
        val two = flag + flag
        assertEquals(two, cutWhole(two + "x", 8))
        assertEquals(flag, cutWhole(two + "x", 7))
        assertEquals(flag, cutWhole(two + "x", 6))
        assertEquals(flag, cutWhole(two + "x", 4))
        assertEquals("", cutWhole(two + "x", 3))
    }

    @Test
    fun aLineBreakOfTwoPartsIsNotSplit() {
        assertEquals("ab", cutWhole("ab\r\ncd", 3))
        assertEquals("ab\r\n", cutWhole("ab\r\ncd", 4))
    }

    @Test
    fun aWebAddressAtTheLimitIsCutAsPlainCharacters() {
        val text = "See " + "x".repeat(50) + " https://kinfolk.tribetails.com/kintales"
        assertEquals(text.take(60), cutWhole(text, 60))
    }

    @Test
    fun aCharacterLongerThanTheBudgetIsDroppedNotHalved() {
        assertEquals("", cutWhole(family, 3))
        assertEquals("", cutWhole("abc", 0))
        assertEquals("", cutWhole("abc", -1))
    }

    @Test
    fun neverLongerThanTheLimitAndNeverHalfAPairOnAMixedMessage() {
        val text = "Hi $family! $womanDog walked $flag $heart$dog $keycap $accented".repeat(6)
        for (max in 0..text.length) {
            val cut = cutWhole(text, max)
            assertTrue(cut.length <= max)
            assertTrue(text.startsWith(cut))
            // No surrogate left without its other half, and no joiner left dangling.
            assertFalse("max $max", cut.isNotEmpty() && cut.last().isHighSurrogate())
            assertFalse("max $max", cut.endsWith("\u200D"))
            // What was dropped does not start with a mark that belonged to the kept part.
            val rest = text.substring(cut.length)
            assertFalse("max $max", rest.startsWith("\uFE0F") || rest.startsWith("\u20E3") || rest.startsWith("\u0301") || rest.startsWith("\u200D"))
        }
    }

    @Test
    fun theRecipientSummaryEndsWholeBeforeItsEllipsis() {
        assertEquals("a".repeat(279) + "…", summaryLine("", "a".repeat(279) + dog + " tail", 280))
        assertEquals("a".repeat(275) + "…", summaryLine("", "a".repeat(275) + family + " tail", 280))
    }
}
