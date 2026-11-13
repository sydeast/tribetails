package com.kinfolk.portal.util

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * #2166: the headline rule both web surfaces use, `title || body.slice(0, n)`
 * (KinTales.tsx: 90 on the featured card, 70 on the rest; Home.tsx: 60).
 */
class KinTaleHeadlineTest {

    private val longBody =
        "Miso ate every bite of dinner, then claimed the windowsill for the whole afternoon and watched the birds."

    @Test
    fun aTitleIsShownWhole() {
        assertEquals("Miso ate every bite", kinTaleHeadline("Miso ate every bite", longBody, KIN_TALE_HEADLINE_CARD_CHARS))
    }

    @Test
    fun aLongTitleIsNeverCut() {
        val title = "Miso ate every bite, then claimed the windowsill, then the couch, then the whole bed for the night"
        assertEquals(title, kinTaleHeadline(title, "b", KIN_TALE_HEADLINE_CARD_CHARS))
        assertEquals(title, kinTaleHeadline(title, "b", KIN_TALE_HEADLINE_HOME_CHARS))
    }

    @Test
    fun noTitleFallsBackToTheBodyOpeningAtEachSurfaceLength() {
        assertEquals(longBody.take(70).trim(), kinTaleHeadline("", longBody, KIN_TALE_HEADLINE_CARD_CHARS))
        assertEquals(longBody.take(90).trim(), kinTaleHeadline("", longBody, KIN_TALE_HEADLINE_FEATURED_CHARS))
        assertEquals(longBody.take(60).trim(), kinTaleHeadline("", longBody, KIN_TALE_HEADLINE_HOME_CHARS))
        assertEquals(longBody.take(70).trim(), kinTaleHeadline(null, longBody, KIN_TALE_HEADLINE_CARD_CHARS))
    }

    @Test
    fun theFallbackCutAddsNoEllipsis() {
        val headline = kinTaleHeadline("", longBody, KIN_TALE_HEADLINE_CARD_CHARS)!!
        assertEquals(false, headline.endsWith("…") || headline.endsWith("..."))
    }

    @Test
    fun aShortBodyIsShownWholeAsTheHeadline() {
        assertEquals("Just a story.", kinTaleHeadline("", "Just a story.", KIN_TALE_HEADLINE_CARD_CHARS))
    }

    @Test
    fun aWhitespaceOnlyTitleCountsAsNoTitle() {
        assertEquals("Just a story.", kinTaleHeadline("   \n ", "Just a story.", KIN_TALE_HEADLINE_CARD_CHARS))
    }

    @Test
    fun noTitleAndABlankBodyMeansNoHeadlineAtAll() {
        assertNull(kinTaleHeadline("", "", KIN_TALE_HEADLINE_CARD_CHARS))
        assertNull(kinTaleHeadline(null, "  \n\n ", KIN_TALE_HEADLINE_CARD_CHARS))
    }

    @Test
    fun lineBreaksInTheBodyOpeningReadAsSpacesAsTheyDoOnWeb() {
        assertEquals("Fed Miso. Walked Kai.", kinTaleHeadline("", "Fed Miso.\n\nWalked   Kai.", KIN_TALE_HEADLINE_CARD_CHARS))
        assertEquals("Two lines of title", kinTaleHeadline("Two lines\nof title", "b", KIN_TALE_HEADLINE_CARD_CHARS))
    }

    @Test
    fun theCutNeverEndsOnHalfAnEmoji() {
        // 69 letters then a paw: the 70th char is the paw's high surrogate.
        val body = "a".repeat(69) + "🐾 and more"
        assertEquals("a".repeat(69), kinTaleHeadline("", body, KIN_TALE_HEADLINE_CARD_CHARS))
    }

    @Test
    fun theBylineNamesTheAuntieAndTheSentLabel() {
        assertEquals("FROM AUNTIE MAYA · sometime in the spring", kinTaleByline("Maya", null, " sometime in the spring "))
        assertEquals("FROM YOUR AUNTIE", kinTaleByline(null, null, null))
        assertEquals("FROM AUNTIE AVERY", kinTaleByline("Auntie Avery", null, "  "))
    }
}
