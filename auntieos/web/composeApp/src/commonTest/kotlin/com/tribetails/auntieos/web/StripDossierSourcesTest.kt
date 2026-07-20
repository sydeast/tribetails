package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.screens.directory.stripDossierSources
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * D1: dossier prose carries inline [[source: <channel> on YYYY-MM-DD]] citations
 * that the operator finds too long. stripDossierSources removes them at render time
 * (Firestore data stays intact), tidying the spacing/punctuation left behind.
 */
class StripDossierSourcesTest {

    @Test
    fun `removes dated source citations and tidies trailing punctuation`() {
        val input = "Loves long walks [[source: sms on 2026-04-12]]. Allergic to peanuts [[source: call on 2026-03-01]]."
        assertEquals("Loves long walks. Allergic to peanuts.", stripDossierSources(input))
    }

    @Test
    fun `removes a mid-sentence citation without leaving a double space`() {
        val input = "Nova [[source: email on 2026-01-01]] is shy with strangers."
        assertEquals("Nova is shy with strangers.", stripDossierSources(input))
    }

    @Test
    fun `text without citations is unchanged`() {
        val input = "Friendly dog, knows sit and stay."
        assertEquals(input, stripDossierSources(input))
    }

    @Test
    fun `handles multiple citations and collapses whitespace`() {
        val input = "A [[source: sms on 2026-01-01]] B [[source: call on 2026-02-02]] C"
        assertEquals("A B C", stripDossierSources(input))
    }
}
