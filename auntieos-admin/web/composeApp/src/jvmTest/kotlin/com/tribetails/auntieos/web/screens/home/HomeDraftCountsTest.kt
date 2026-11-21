package com.tribetails.auntieos.web.screens.home

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * #1850: the "KinTales to review" card's line under its number must not be a
 * second, different count ("4 recent drafts" under 12 on the web, "N total
 * drafts" here, which counted sent drafts too).
 */
class HomeDraftCountsTest {
    @Test
    fun theTrendSaysWhatTheNumberCounts() {
        assertEquals("drafts waiting to send", kinTalesReviewTrend(12))
        assertEquals("all caught up", kinTalesReviewTrend(0))
    }

    @Test
    fun theListSaysWhenItShowsFewerThanAreWaiting() {
        assertEquals("Newest 4 of 12 drafts.", pendingShownLine(shown = 4, total = 12))
        assertNull(pendingShownLine(shown = 4, total = 4))
        assertNull(pendingShownLine(shown = 0, total = 0))
    }
}
