package com.tribetails.auntieos.web.screens.trainingdocs

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

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
            assertFalse(TRIBAL_INTEL_FORM_TIP.contains(word, ignoreCase = true), word)
        }
    }
}
