package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** #1595: Pinned visits is a plain label; what it means is the info tip. */
class PinnedVisitsTipTest {
    @Test
    fun labelIsTheNameAlone() {
        assertEquals("Pinned visits", PINNED_VISITS_LABEL)
        assertFalse(PINNED_VISITS_TIP.startsWith(PINNED_VISITS_LABEL))
    }

    @Test
    fun tipSaysWhatPinnedVisitsDo() {
        assertTrue(PINNED_VISITS_TIP.contains("non-negotiables"))
        assertTrue(PINNED_VISITS_TIP.contains("New blank packages start with these"))
    }
}
