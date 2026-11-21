package com.tribetails.auntieos.domain

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * #2408: what a household is texted for an approved Text draft. The expected
 * lines are the server's `householdSms` answers for the same words, and the
 * same vectors are asserted on the web admin (`lib/householdText.test.ts`).
 */
class HouseholdTextTest {
    // Written as escapes so the invisible parts can be read here.
    private val family = "👨‍👩‍👧" // man, joiner, woman, joiner, girl
    @Test
    fun aShortMessageGoesWholeWithTheLinkAfterIt() {
        assertEquals(HouseholdTextPreview("See you Friday at 9.", cut = false, linkAdded = true), householdTextPreview("See you Friday at 9."))
        assertEquals(HouseholdTextPreview("h".repeat(200), cut = false, linkAdded = true), householdTextPreview("h".repeat(200)))
    }
    @Test
    fun aLongMessageIsCutAtTheEndOfAWordWithItsLineBreaksFolded() {
        val body = "Biscuit had a grand morning.\n\nShe ate all of her breakfast, went twice round the long field and made friends " +
            "with the new spaniel at the gate. We found the missing blue lead behind the shed, and her coat is brushed out " +
            "ready for Friday. Bring the red harness if you can."
        assertEquals(
            HouseholdTextPreview(
                line = "Biscuit had a grand morning. She ate all of her breakfast, went twice round the long field and made friends " +
                    "with the new spaniel at the gate. We found the missing blue lead behind the shed, and her...",
                cut = true,
                linkAdded = true,
            ),
            householdTextPreview(body),
        )
    }
    @Test
    fun oneCharacterOverIsCut() {
        assertEquals(HouseholdTextPreview("h".repeat(197) + "...", cut = true, linkAdded = true), householdTextPreview("h".repeat(201)))
    }
    @Test
    fun neverEndsOnPartOfAnEmoji() {
        assertEquals("a".repeat(190) + "...", householdTextPreview("a".repeat(190) + family.repeat(6)).line)
    }
    @Test
    fun stepsBackOverAShortUnfinishedWordAndKeepsTheStartOfAVeryLongOne() {
        assertEquals("e".repeat(185) + " fghij...", householdTextPreview("e".repeat(185) + " fghij klmnopqrstu vwxyz").line)
        assertEquals("b".repeat(150) + " " + "c".repeat(46) + "...", householdTextPreview("b".repeat(150) + " " + "c".repeat(80)).line)
        assertEquals("g ".repeat(99).trim() + "...", householdTextPreview("g ".repeat(120) + "end").line)
    }
    @Test
    fun dropsAWebAddressTheCutLandedInside() {
        val body = "d".repeat(170) + " https://example.org/a/very/long/path/that/keeps/going/on/and/on"
        assertEquals("d".repeat(170) + "...", householdTextPreview(body).line)
    }
    @Test
    fun aMessageThatAlreadyLinksToMyTribeAndFitsGoesAsWritten() {
        val body = "Every date: $MYTRIBE_URL/schedule and more."
        assertEquals(HouseholdTextPreview(body, cut = false, linkAdded = false), householdTextPreview(body))
        assertEquals(body, householdTextPreviewLine(body))
    }
    @Test
    fun aLongMessageHasItsOwnMyTribeLinkTakenOutBeforeTheCut() {
        assertEquals(
            HouseholdTextPreview("g ".repeat(99).trim() + "...", cut = true, linkAdded = true),
            householdTextPreview("g ".repeat(120) + "$MYTRIBE_URL/schedule end"),
        )
    }
    @Test
    fun nothingTypedIsNothing() {
        assertEquals(HouseholdTextPreview("", cut = false, linkAdded = false), householdTextPreview("  \n "))
        assertEquals("", householdTextPreviewLine(""))
    }
    @Test
    fun thePreviewLineNamesTheLinkWithoutInventingAnAddress() {
        assertEquals("See you Friday at 9. More in MyTribe: (link)", householdTextPreviewLine("See you Friday at 9."))
    }
}
