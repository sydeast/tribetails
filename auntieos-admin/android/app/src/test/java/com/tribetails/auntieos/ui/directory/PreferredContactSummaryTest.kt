package com.tribetails.auntieos.ui.directory

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PreferredContactSummaryTest {

    @Test fun runTogetherPrefs_collapseToDistinctChannel() {
        // Run 4: demo data jammed "Channel: category" prefs with no separator into the field.
        assertEquals(
            "Email",
            preferredContactSummary("Email: Pet Care Journals & CommentsEmail: Important Business Updates"),
        )
    }

    @Test fun multipleDistinctChannels_listedOnce_inOrder() {
        assertEquals("Email, Text", preferredContactSummary("Email for journals, Text for urgent"))
    }

    @Test fun shortChannel_passesThroughUnchanged() {
        assertEquals("Text", preferredContactSummary("Text"))
        assertEquals("Email", preferredContactSummary("Email"))
    }

    @Test fun blankOrWhitespace_isEmpty() {
        assertEquals("", preferredContactSummary("   "))
        assertEquals("", preferredContactSummary(""))
    }

    @Test fun unknownValue_collapsedAndTruncated() {
        val long = "Carrier pigeon to the third oak past the river bend near the old mill house"
        val out = preferredContactSummary(long)
        assertTrue("expected truncation, got ${out.length}", out.length <= 40)
        assertTrue(out.endsWith("…"))
    }
}
