package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The KinTales result-count chip and the list outcome it shares a source with
 * (mock SUGGESTION 3, approved 2026-08-09), tested as pure functions because the
 * Android unit suite is JVM-only.
 *
 * Both rules exist to stop the same two lies: a count that reads as an archive
 * when it is a page, and a search that empties the screen without saying it did.
 */
class KinTaleLogsCountTest {

    // ── resultCountLabel ────────────────────────────────────────────────────

    @Test
    fun statesTheLoadedCountWhenNothingWasExcluded() {
        assertEquals(
            "12 loaded",
            resultCountLabel(loaded = 12, matching = 12, isLoading = false, hasError = false),
        )
    }

    @Test
    fun statesBothNumbersOnceTheSearchExcludedSomething() {
        assertEquals(
            "3 of 12 loaded",
            resultCountLabel(loaded = 12, matching = 3, isLoading = false, hasError = false),
        )
    }

    @Test
    fun anHonestZeroKeepsTheDenominatorTheOperatorCanSee() {
        assertEquals(
            "0 of 12 loaded",
            resultCountLabel(loaded = 12, matching = 0, isLoading = false, hasError = false),
        )
    }

    @Test
    fun claimsNoCountAtAllWhileTheFirstReadIsStillInFlight() {
        assertNull(resultCountLabel(loaded = 0, matching = 0, isLoading = true, hasError = false))
    }

    @Test
    fun claimsNoCountAtAllWhenTheReadFAILEDRatherThanAConfidentZero() {
        // The failed read leaves isLoading false and the list empty, which is
        // indistinguishable from an empty workspace unless the chip stays away.
        assertNull(resultCountLabel(loaded = 0, matching = 0, isLoading = false, hasError = true))
    }

    @Test
    fun keepsShowingTheCountWhileAPullToRefreshReloadsAlreadyReadRows() {
        // A refresh over rows already on screen is not an unknown count.
        assertEquals(
            "12 loaded",
            resultCountLabel(loaded = 12, matching = 12, isLoading = true, hasError = false),
        )
    }

    @Test
    fun keepsTheCountWhenAREFRESHFailsOverRowsAlreadyOnScreen() {
        // Those 12 rows are still on screen and still 12. A failed refresh is
        // not a reason to stop describing what the operator can see.
        assertEquals(
            "12 loaded",
            resultCountLabel(loaded = 12, matching = 12, isLoading = false, hasError = true),
        )
    }

    @Test
    fun aProvenEmptyWindowIsAllowedToSayZero() {
        assertEquals(
            "0 loaded",
            resultCountLabel(loaded = 0, matching = 0, isLoading = false, hasError = false),
        )
    }

    // ── listOutcome ─────────────────────────────────────────────────────────

    @Test
    fun rowsWhenSomethingMatched() {
        assertEquals(
            ListOutcome.Rows,
            listOutcome(loaded = 4, matching = 2, orphans = 0, isLoading = false),
        )
    }

    @Test
    fun aSearchThatMatchedNothingIsNamed_notLeftBlank() {
        assertEquals(
            ListOutcome.NoMatch,
            listOutcome(loaded = 4, matching = 0, orphans = 0, isLoading = false),
        )
    }

    @Test
    fun aNoMatchStaysANoMatchEvenWithOrphansAwaitingTriageAbove() {
        assertEquals(
            ListOutcome.NoMatch,
            listOutcome(loaded = 4, matching = 0, orphans = 3, isLoading = false),
        )
    }

    @Test
    fun anEmptyWorkspaceIsTheEmptyState_notANoMatch() {
        assertEquals(
            ListOutcome.Empty,
            listOutcome(loaded = 0, matching = 0, orphans = 0, isLoading = false),
        )
    }

    @Test
    fun orphansAloneAreNotAnEmptyWorkspace() {
        // The triage queue is the content; claiming "No KinTales found" over it
        // would be a confident empty about rows that are on the screen.
        assertEquals(
            ListOutcome.Rows,
            listOutcome(loaded = 0, matching = 0, orphans = 2, isLoading = false),
        )
    }

    @Test
    fun claimsNothingAtAllWhileTheFirstReadIsStillInFlight() {
        assertEquals(
            ListOutcome.Loading,
            listOutcome(loaded = 0, matching = 0, orphans = 0, isLoading = true),
        )
    }
}
