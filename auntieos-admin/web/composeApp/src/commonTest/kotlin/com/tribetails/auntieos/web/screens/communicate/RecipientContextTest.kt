package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.data.Kinfolk
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Pure pre-flight for the "Refresh intelligence" (on-demand profile synthesis)
 * action. Mirrors the Android CommunicateViewModel guard (H-A3): synthesis needs
 * a selected recipient whose id is sent to the synthesize_kinfolk_profile
 * callable, so a missing recipient must fail loud, never silently no-op.
 */
class RecipientContextTest {

    @Test
    fun nullRecipientIsBlocked() {
        assertNotNull(
            "synthesizeBlocker must return a fail-loud reason when no recipient is selected",
            synthesizeBlocker(null),
        )
    }

    @Test
    fun recipientWithBlankIdIsBlocked() {
        assertNotNull(
            "a recipient with no id cannot be synthesized",
            synthesizeBlocker(Kinfolk(_id = "")),
        )
    }

    @Test
    fun recipientWithIdIsClear() {
        assertNull(synthesizeBlocker(Kinfolk(_id = "kf1")))
    }

    // ── kinMetaLine: the "species · breed" line under a kin's name in KinCard ──

    @Test
    fun kinMetaLineJoinsSpeciesAndBreed() {
        assertEquals("Dog · Poodle", kinMetaLine("Dog", "Poodle"))
    }

    @Test
    fun kinMetaLineSpeciesOnlyWhenBreedBlank() {
        assertEquals("Dog", kinMetaLine("Dog", ""))
    }

    @Test
    fun kinMetaLineBreedOnlyWhenSpeciesBlank() {
        assertEquals("Poodle", kinMetaLine("", "Poodle"))
    }

    @Test
    fun kinMetaLineEmptyWhenNeither() {
        assertEquals("", kinMetaLine("", ""))
    }

    @Test
    fun kinMetaLineTrimsAndTreatsWhitespaceAsBlank() {
        assertEquals("Poodle", kinMetaLine("   ", " Poodle "))
        assertEquals("Dog · Lab", kinMetaLine(" Dog ", " Lab "))
    }

    // ── contextFieldShown: hide blank + reconcile-placeholder dossier/411 fields ──

    @Test
    fun contextFieldHiddenForBlank() {
        assertFalse(contextFieldShown(""))
        assertFalse(contextFieldShown("   "))
    }

    @Test
    fun contextFieldHiddenForNotYetDocumentedPlaceholder() {
        assertFalse(contextFieldShown("Not yet documented."))
    }

    @Test
    fun contextFieldShownForRealValue() {
        assertTrue(contextFieldShown("Loves long walks"))
    }
}
