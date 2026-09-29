package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** #957: the Email frame draft. Same rules as the web twin, `emailFrameDraft.test.ts`. */
class EmailFrameDraftTest {

    @Test
    fun `the draft has every field, blank where nothing is stored`() {
        val d = emailFrameDraftFrom(mapOf("accentColor" to "#123456"))
        assertEquals(EmailFrameFields.ALL.toSet(), d.keys)
        assertEquals("#123456", d["accentColor"])
        assertEquals("", d["footerText"])
    }

    @Test
    fun `an untouched draft has no changes`() {
        val stored = mapOf("accentColor" to "#123456", "footerText" to "Hi")
        assertTrue(emailFrameChanges(emailFrameDraftFrom(stored), stored).isEmpty())
    }

    @Test
    fun `only changed fields are sent, a cleared one as null`() {
        val stored = mapOf("accentColor" to "#123456", "footerText" to "Hi")
        val draft = emailFrameDraftFrom(stored) + mapOf("accentColor" to "#ABCDEF", "footerText" to "  ", "textColor" to "#000000")
        assertEquals(
            mapOf("accentColor" to "#abcdef", "footerText" to null, "textColor" to "#000000"),
            emailFrameChanges(draft, stored),
        )
    }

    @Test
    fun `a stored field this client has no control for is never in the diff`() {
        val stored = mapOf("futureField" to "keep me", "accentColor" to "#123456")
        val draft = emailFrameDraftFrom(stored) + ("accentColor" to "#654321")
        assertEquals(mapOf("accentColor" to "#654321"), emailFrameChanges(draft, stored))
    }

    @Test
    fun `case and spaces alone are not a change`() {
        val stored = mapOf("accentColor" to "#abcdef", "headerText" to "Top")
        val draft = emailFrameDraftFrom(stored) + mapOf("accentColor" to "#ABCDEF", "headerText" to " Top ")
        assertTrue(emailFrameChanges(draft, stored).isEmpty())
    }

    @Test
    fun `the preview frame has only set fields`() {
        val draft = emailFrameDraftFrom(emptyMap()) + mapOf("accentColor" to "#123456", "footerText" to " ")
        assertEquals(mapOf("accentColor" to "#123456"), emailFramePreviewFrame(draft))
    }

    @Test
    fun `problems match what the server refuses`() {
        assertNotNull(emailFrameFieldProblem("accentColor", "red"))
        assertNotNull(emailFrameFieldProblem("accentColor", "#12345"))
        assertNull(emailFrameFieldProblem("accentColor", "#12AB5f"))
        assertNotNull(emailFrameFieldProblem("headerText", "x".repeat(81)))
        assertNotNull(emailFrameFieldProblem("footerText", "Hi {{name}}"))
        assertNull(emailFrameFieldProblem("footerText", ""))
        assertEquals(setOf("textColor"), emailFrameProblems(emailFrameDraftFrom(emptyMap()) + ("textColor" to "blue")).keys)
    }

    @Test
    fun `a swatch color is parsed only from a full hex`() {
        assertEquals(0xFFDF8431L, emailFrameColorArgb("#df8431"))
        assertNull(emailFrameColorArgb("#df84"))
    }
}
