package com.tribetails.auntieos.domain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1858. The line at the top of a tier ("The 2h day fits inside the 24h max gap, so
 * this tier is one check-in at 12:00 PM.") was written when the tier was built and
 * kept on the package: it went on saying 24h after Max gap became 6, and stayed after
 * the package's visit was removed. [packageNote] reads it off the rules and the
 * visits as they are now. Mirrors the web `packageNote` tests.
 */
class PackageNoteTest {
    /** A 3 hour day with no pinned visit: every tier is one check-in at 12:30 PM. */
    private fun short(gap: Double) = buildDayPatterns(DEFAULT_DURATIONS, emptyList(), gap, "11:00", "14:00")
    private fun tier(gap: Double) = packagesFromPatterns(short(gap)).first()

    @Test
    fun saysTheMaxGapTheRulesHoldNowNotTheOneTheTierWasBuiltUnder() {
        val built = tier(24.0)
        assertEquals("The 3h day fits inside the 24h max gap, so this tier is one check-in at 12:30 PM.", packageNote(built, short(24.0)))
        assertEquals("The 3h day fits inside the 6h max gap, so this tier is one check-in at 12:30 PM.", packageNote(built, short(6.0)))
    }

    @Test
    fun isEmptyOnceTheRulesNoLongerBuildThatTier() {
        // A 2h gap fills the 3h day on purpose; a 15h day under a 6h gap builds three check-ins.
        assertEquals("", packageNote(tier(24.0), short(2.0)))
        assertEquals("", packageNote(tier(24.0), buildDayPatterns(DEFAULT_DURATIONS, emptyList(), 6.0, "07:00", "22:00")))
    }

    @Test
    fun isEmptyOnceTheVisitIsRemovedMovedOrJoinedByAnother() {
        val built = tier(6.0)
        val only = built.visits.first()
        assertEquals("", packageNote(built.copy(visits = emptyList()), short(6.0)))
        assertEquals("", packageNote(built.copy(visits = listOf(only.copy(time = only.time + 30))), short(6.0)))
        assertEquals("", packageNote(built.copy(visits = listOf(only, only.copy(id = "x", time = 800))), short(6.0)))
    }

    @Test
    fun aDuplicateCarriesItOnlyWhileItHoldsTheCheckIn() {
        val built = tier(6.0)
        // What the screen's Duplicate does: new ids, same visits.
        val copy = built.copy(id = "copy", name = "Balance copy", visits = built.visits.map { it.copy(id = uid()) })
        assertTrue(packageNote(copy, short(6.0)).isNotEmpty())
        assertEquals("", packageNote(copy.copy(visits = emptyList()), short(6.0)))
    }

    @Test
    fun ignoresTheLabelTheIdsAndTheOrderTheVisitsAreHeldIn() {
        val built = tier(6.0)
        assertTrue(packageNote(built.copy(visits = listOf(built.visits.first().copy(id = "c", label = "Lunch"))), short(6.0)).isNotEmpty())
        val pinned = listOf(PinnedTime("a", "AM", "15:00", "d2"), PinnedTime("b", "PM", "12:00", "d3"))
        // A reversed day window still explains itself on a tier with several visits.
        val patterns = buildDayPatterns(DEFAULT_DURATIONS, pinned, 6.0, "14:00", "11:00")
        val many = packagesFromPatterns(patterns).first()
        assertTrue(many.visits.size > 1)
        assertTrue(packageNote(many.copy(visits = many.visits.reversed()), patterns).contains("7:00 AM to 10:00 PM"))
    }

    @Test
    fun isEmptyForATierThatMetTheRulesAndForAHandBuiltPackage() {
        val met = buildDayPatterns(DEFAULT_DURATIONS, emptyList(), 3.0, "07:00", "22:00")
        assertEquals("", packageNote(packagesFromPatterns(met).first(), met))
        assertEquals("", packageNote(normalizePackage(name = "Package 4"), short(6.0)))
        assertEquals("", packageNote(Package("h", "Mine", listOf(Visit("v", 540, "d2", "Morning"))), short(6.0)))
    }
}
