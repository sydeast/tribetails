package com.tribetails.auntieos.ui.directory

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * D1 (A8): dossier prose carries inline [[source: <channel> on YYYY-MM-DD]] citations
 * the operator finds noisy; strip them at render (Firestore data stays intact) and tidy
 * the spacing left behind. Mirror of the web StripDossierSourcesTest.
 */
class StripDossierSourcesTest {

    @Test fun removesDatedCitationsAndTidiesPunctuation() {
        val input = "Loves long walks [[source: sms on 2026-04-12]]. Allergic to peanuts [[source: call on 2026-03-01]]."
        assertEquals("Loves long walks. Allergic to peanuts.", stripDossierSources(input))
    }

    @Test fun removesMidSentenceCitationWithoutDoubleSpace() {
        val input = "Nova [[source: email on 2026-01-01]] is shy with strangers."
        assertEquals("Nova is shy with strangers.", stripDossierSources(input))
    }

    @Test fun textWithoutCitationsUnchanged() {
        val input = "Friendly dog, knows sit and stay."
        assertEquals(input, stripDossierSources(input))
    }

    @Test fun handlesMultipleCitations() {
        val input = "A [[source: sms on 2026-01-01]] B [[source: call on 2026-02-02]] C"
        assertEquals("A B C", stripDossierSources(input))
    }
}
