package com.kinfolk.portal.screens.kintales

import com.kinfolk.portal.portal.KinTaleReaction
import kotlin.test.Test
import kotlin.test.assertEquals

/** Same phrasing table as web's loveLine() in kinTalesApi.ts — kept in sync by hand. */
class KinTaleLoveLineTest {

    @Test
    fun matchesTheMockupExactly_lovedByMePlusTwoOthers() {
        assertEquals("You and 2 others loved this", kinTaleLoveLine(KinTaleReaction(loved = true, loveCount = 3)))
    }

    @Test
    fun singularOtherForExactlyOneOther() {
        assertEquals("You and 1 other loved this", kinTaleLoveLine(KinTaleReaction(loved = true, loveCount = 2)))
    }

    @Test
    fun justYouLovedThis_whenNobodyElseHas() {
        assertEquals("You loved this", kinTaleLoveLine(KinTaleReaction(loved = true, loveCount = 1)))
    }

    @Test
    fun nPeopleLovedThis_whenOthersLovedItButNotMe() {
        assertEquals("3 people loved this", kinTaleLoveLine(KinTaleReaction(loved = false, loveCount = 3)))
    }

    @Test
    fun singularPersonForExactlyOneOther() {
        assertEquals("1 person loved this", kinTaleLoveLine(KinTaleReaction(loved = false, loveCount = 1)))
    }

    @Test
    fun invitesTheFirstLove_whenNobodyHasReacted() {
        assertEquals("Be the first to love this", kinTaleLoveLine(KinTaleReaction(loved = false, loveCount = 0)))
    }
}
