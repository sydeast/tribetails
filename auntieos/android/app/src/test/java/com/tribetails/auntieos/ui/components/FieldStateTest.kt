package com.tribetails.auntieos.ui.components

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 0B, Android parity for the field focus/error decision logic. Mirrors web FieldState. */
class FieldStateTest {

    @Test fun blur_fires_only_when_focus_lost_after_being_focused() {
        assertTrue(blurOccurred(wasFocused = true, nowFocused = false))
    }

    @Test fun blur_does_not_fire_on_gaining_focus() {
        assertFalse(blurOccurred(wasFocused = false, nowFocused = true))
    }

    @Test fun blur_does_not_fire_on_first_render() {
        assertFalse(blurOccurred(wasFocused = false, nowFocused = false))
    }

    @Test fun blur_does_not_fire_while_staying_focused() {
        assertFalse(blurOccurred(wasFocused = true, nowFocused = true))
    }

    @Test fun field_has_error_with_message() {
        assertTrue(fieldHasError(isError = false, errorMessage = "Required"))
    }

    @Test fun field_has_error_with_flag() {
        assertTrue(fieldHasError(isError = true, errorMessage = null))
    }

    @Test fun field_has_no_error_when_clean() {
        assertFalse(fieldHasError(isError = false, errorMessage = null))
        assertFalse(fieldHasError(isError = false, errorMessage = ""))
    }
}
