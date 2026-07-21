package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-helper tests for KinCareSessionsScreen.appendOfficeNote. Locks the
 * prepend-with-timestamp formatting so we don't accidentally clobber existing
 * notes during a refactor. Per [[compose-pure-helper-tdd]] decision logic
 * lives in a top-level helper tested under pure JVM.
 */
class SessionNoteHelpersTest {

    @Test
    fun `blank addition returns existing unchanged`() {
        assertEquals("prior note", appendOfficeNote("prior note", ""))
    }

    @Test
    fun `whitespace-only addition returns existing unchanged`() {
        assertEquals("prior note", appendOfficeNote("prior note", "   \n\t  "))
    }

    @Test
    fun `addition onto empty notes produces stamped line only`() {
        val out = appendOfficeNote("", "supplies low")
        // [<iso>] (office) supplies low
        assertTrue("expected leading bracket, got: '$out'", out.startsWith("["))
        assertTrue("expected (office) marker, got: '$out'", out.contains("(office) supplies low"))
        // No newline appended when existing was empty.
        assertTrue("expected no trailing existing block, got: '$out'", out.lines().size == 1)
    }

    @Test
    fun `addition onto existing notes prepends new line`() {
        val out = appendOfficeNote("prior note", "kinfolk asked to reschedule")
        val lines = out.lines()
        assertEquals(2, lines.size)
        assertTrue("first line should be stamped office note, got: '${lines[0]}'",
            lines[0].contains("(office) kinfolk asked to reschedule"))
        assertEquals("prior note", lines[1])
    }

    @Test
    fun `addition is trimmed before inclusion`() {
        val out = appendOfficeNote("", "   needs follow-up   ")
        assertTrue("expected trimmed body, got: '$out'", out.endsWith("needs follow-up"))
    }
}
