package com.tribetails.auntieos.ui.home

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * #1850: Home read 12 with "3 recent drafts" under it while KinTales pending
 * listed 3. The small number was the list's row cap, not anything the card counts.
 */
class HomeDraftCountsTest {
    @Test
    fun `the trend says what the number counts`() {
        assertEquals("drafts waiting to send", kinTalesReviewTrend(12))
        assertEquals("drafts waiting to send", kinTalesReviewTrend(1))
        assertEquals("all caught up", kinTalesReviewTrend(0))
    }

    @Test
    fun `the list says when it shows fewer than are waiting`() {
        assertEquals("Newest 3 of 12 drafts.", pendingShownLine(shown = 3, total = 12))
    }

    @Test
    fun `no line when the list holds every draft waiting`() {
        assertNull(pendingShownLine(shown = 3, total = 3))
        assertNull(pendingShownLine(shown = 0, total = 0))
    }
}
