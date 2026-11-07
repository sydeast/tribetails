package com.tribetails.auntieos.ui.admin
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
/** #1616: the screen's own words describe notes, not training materials, guides or a search box it lacks. */
class TribalIntelCopyTest {
    private val words = listOf(TRIBAL_INTEL_SUBTITLE, TRIBAL_INTEL_EMPTY_MESSAGE)
    @Test
    fun copyNeverMentionsTrainingMaterialsOrGuides() {
        words.forEach { w ->
            assertFalse(w, w.contains("training", ignoreCase = true))
            assertFalse(w, w.contains("guide", ignoreCase = true))
            assertFalse(w, w.contains("educational", ignoreCase = true))
        }
    }
    @Test
    fun copyNamesWhatTheScreenHolds() {
        assertTrue(TRIBAL_INTEL_SUBTITLE.contains("household"))
        assertTrue(TRIBAL_INTEL_EMPTY_MESSAGE.contains("pet"))
    }
}
