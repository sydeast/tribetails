package com.tribetails.auntieos.ui.kintales

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The composer's rules, pinned against the React composer they were ported from
 * (`auntieos-admin/src/lib/kinTaleDraftSchema.ts`).
 *
 * The point of these is drift: the two clients write the same document with no
 * server-side schema between them, so the only thing keeping their rules the same
 * is a test that says what the rules are.
 */
class KinTaleDraftValidationTest {

    // ── headline ─────────────────────────────────────────────────────────────

    @Test
    fun `a clean headline has no error`() {
        assertNull(kinTaleTitleError("A great day at the park"))
    }

    @Test
    fun `a blank headline is not an error, because a draft may be half written`() {
        assertNull(kinTaleTitleError(""))
        assertNull(kinTaleTitleError("   "))
    }

    @Test
    fun `the headline cap is 120 characters, counted after trimming`() {
        assertNull(kinTaleTitleError("a".repeat(KIN_TALE_TITLE_MAX)))
        assertEquals(
            "Keep the headline under 120 characters.",
            kinTaleTitleError("a".repeat(KIN_TALE_TITLE_MAX + 1)),
        )
        // Trailing whitespace is not content, so it must not push a legal headline
        // over the line.
        assertNull(kinTaleTitleError("a".repeat(KIN_TALE_TITLE_MAX) + "     "))
    }

    @Test
    fun `an em dash in the headline is refused with the same words the web uses`() {
        assertEquals(
            "Auntie does not use dashes. Try a comma, ellipses (.....), or parentheses.",
            kinTaleTitleError("Biscuit — the best boy"),
        )
    }

    @Test
    fun `an en dash is refused too, and a plain hyphen is not`() {
        assertNotNull(kinTaleTitleError("Biscuit – the best boy"))
        assertNull(kinTaleTitleError("Biscuit, the best-behaved boy"))
    }

    @Test
    fun `length is reported before punctuation when a headline breaks both`() {
        // First message per field wins, same as the web's field-keyed flattening.
        val error = kinTaleTitleError("a".repeat(200) + "—")
        assertEquals("Keep the headline under 120 characters.", error)
    }

    // ── body ─────────────────────────────────────────────────────────────────

    @Test
    fun `the body takes the dash rule and no length cap`() {
        assertNull(kinTaleBodyError("x".repeat(5_000)))
        assertEquals(
            "Auntie does not use dashes. Try a comma, ellipses (.....), or parentheses.",
            kinTaleBodyError("We walked to the river — twice."),
        )
    }

    @Test
    fun `a blank body is clean, so a photo-only draft still saves`() {
        assertNull(kinTaleBodyError(""))
    }

    // ── send blocker ─────────────────────────────────────────────────────────

    @Test
    fun `a tale with no session cannot be sent, and says why`() {
        assertEquals(
            "This tale is not linked to an Auntie Time visit, so it cannot be sent. Save it as a draft.",
            kinTaleSendBlocker(""),
        )
        assertEquals(kinTaleSendBlocker("   "), kinTaleSendBlocker(""))
    }

    @Test
    fun `a tale with a session has no send blocker`() {
        assertNull(kinTaleSendBlocker("sess-1"))
    }

    // ── eligibility ──────────────────────────────────────────────────────────

    @Test
    fun `only a visit that has happened is eligible`() {
        assertTrue(isKinTaleEligibleSession("DEPARTED"))
        assertTrue(isKinTaleEligibleSession("COMPLETED"))
    }

    @Test
    fun `a visit still in flight, cancelled, or unrecognised is not eligible`() {
        assertFalse(isKinTaleEligibleSession("SCHEDULED"))
        assertFalse(isKinTaleEligibleSession("ON_MY_WAY"))
        assertFalse(isKinTaleEligibleSession("ARRIVED"))
        assertFalse(isKinTaleEligibleSession("CANCELLED"))
        // Positive membership: a status this build has never heard of stays OUT
        // rather than falling through a negation.
        assertFalse(isKinTaleEligibleSession("PENDING_REVIEW"))
        assertFalse(isKinTaleEligibleSession(""))
    }

    @Test
    fun `status is free text on the document, so it is normalised before the test`() {
        assertTrue(isKinTaleEligibleSession(" departed "))
        assertTrue(isKinTaleEligibleSession("Completed"))
    }
}
