package com.tribetails.auntieos.web.screens.trainingdocs
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue
/** #1616: the screen's own words describe notes, not training materials or guides. */
class TribalIntelCopyTest {
    private val words = listOf(TRIBAL_INTEL_SUBTITLE, TRIBAL_INTEL_EMPTY_MESSAGE)
    @Test fun neverMentionsTrainingMaterialsOrGuides() = words.forEach { w ->
        assertFalse(w.contains("training", ignoreCase = true), w)
        assertFalse(w.contains("guide", ignoreCase = true), w)
        assertFalse(w.contains("educational", ignoreCase = true), w)
    }
    @Test fun namesWhatTheScreenHolds() {
        assertTrue(TRIBAL_INTEL_SUBTITLE.contains("household"))
        assertTrue(TRIBAL_INTEL_EMPTY_MESSAGE.contains("pet"))
    }
}
