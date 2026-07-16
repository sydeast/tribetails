package com.tribetails.auntieos.ui.components

/** 0B, focus/error decision logic shared by the Android field primitives. Mirrors web. */

/**
 * True only on the transition from focused to unfocused. A never-focused field
 * must NOT validate itself on first render, and gaining focus must not validate.
 */
fun blurOccurred(wasFocused: Boolean, nowFocused: Boolean): Boolean =
    wasFocused && !nowFocused

/** True when the field should render in its error state. */
fun fieldHasError(isError: Boolean, errorMessage: String?): Boolean =
    isError || !errorMessage.isNullOrBlank()
