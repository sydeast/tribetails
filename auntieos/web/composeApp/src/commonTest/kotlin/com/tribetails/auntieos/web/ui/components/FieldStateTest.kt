package com.tribetails.auntieos.web.ui.components

import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 0B, focus/error decision logic shared by the field primitives. Pure so the
 * blur-timing rule (validate on losing focus, never on first render) is locked
 * by tests rather than by fiddly Compose focus interaction.
 */
class FieldStateTest {

    @Test fun `blur fires only when focus is lost after being focused`() {
        assertTrue(blurOccurred(wasFocused = true, nowFocused = false))
    }

    @Test fun `blur does not fire on gaining focus`() {
        assertFalse(blurOccurred(wasFocused = false, nowFocused = true))
    }

    @Test fun `blur does not fire on first render while unfocused`() {
        // was=false, now=false: a never-focused field must not validate itself.
        assertFalse(blurOccurred(wasFocused = false, nowFocused = false))
    }

    @Test fun `blur does not fire while staying focused`() {
        assertFalse(blurOccurred(wasFocused = true, nowFocused = true))
    }

    @Test fun `field has error when an error message is present`() {
        assertTrue(fieldHasError(isError = false, errorMessage = "Required"))
    }

    @Test fun `field has error when isError flag set even without message`() {
        assertTrue(fieldHasError(isError = true, errorMessage = null))
    }

    @Test fun `field has no error when clean`() {
        assertFalse(fieldHasError(isError = false, errorMessage = null))
        assertFalse(fieldHasError(isError = false, errorMessage = ""))
    }
}
