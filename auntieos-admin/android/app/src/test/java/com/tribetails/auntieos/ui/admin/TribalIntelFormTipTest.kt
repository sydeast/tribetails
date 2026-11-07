package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** #1595: the Tribal Intel form explains itself in a tip, in plain words. */
class TribalIntelFormTipTest {
    @Test
    fun tipSaysWhereTheNoteGoesAndWhen() {
        assertTrue(TRIBAL_INTEL_FORM_TIP.contains("dossier"))
        assertTrue(TRIBAL_INTEL_FORM_TIP.contains("overnight"))
    }

    @Test
    fun tipCarriesNoPipelineJargon() {
        for (word in listOf("reconcile", "provenance", "summarizer", "the AI")) {
            assertFalse(word, TRIBAL_INTEL_FORM_TIP.contains(word, ignoreCase = true))
        }
    }
}
