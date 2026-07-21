package com.tribetails.auntieos.ui.location

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-helper tests for LiveTrackingScreen.buildVisitNoteAppendix. Locks the
 * (field) timestamp-prepend semantics so the auntie's field note format
 * stays distinguishable from (office) admin notes in the KinTale composer.
 * Per [[compose-pure-helper-tdd]] decision logic lives in a top-level helper.
 */
class LiveTrackingHelpersTest {

    @Test
    fun `blank addition returns existing unchanged`() {
        assertEquals("prior", buildVisitNoteAppendix("prior", ""))
    }

    @Test
    fun `whitespace-only addition returns existing unchanged`() {
        assertEquals("prior", buildVisitNoteAppendix("prior", "   "))
    }

    @Test
    fun `addition onto empty produces single stamped line`() {
        val out = buildVisitNoteAppendix("", "Bailey enjoyed the walk")
        assertTrue("expected leading bracket, got: '$out'", out.startsWith("["))
        assertTrue("expected (field) marker, got: '$out'", out.contains("(field) Bailey enjoyed the walk"))
        assertEquals(1, out.lines().size)
    }

    @Test
    fun `addition onto existing prepends new line`() {
        val out = buildVisitNoteAppendix("admin note here", "field observation")
        val lines = out.lines()
        assertEquals(2, lines.size)
        assertTrue("first line should be field stamped, got: '${lines[0]}'",
            lines[0].contains("(field) field observation"))
        assertEquals("admin note here", lines[1])
    }

    @Test
    fun `addition is trimmed before inclusion`() {
        val out = buildVisitNoteAppendix("", "  trimmed text  ")
        assertTrue("expected trimmed body, got: '$out'", out.endsWith("trimmed text"))
    }

    @Test
    fun `field marker is distinct from office marker`() {
        val fieldNote  = buildVisitNoteAppendix("", "auntie wrote this")
        // The office-side helper lives in KinCareSessionsScreen and uses
        // (office) - this test asserts that the field marker never
        // accidentally collides with it (would lose audit trail clarity).
        assertTrue(fieldNote.contains("(field)"))
        assertTrue("field note must not look like an office note: '$fieldNote'",
            !fieldNote.contains("(office)"))
    }
}
