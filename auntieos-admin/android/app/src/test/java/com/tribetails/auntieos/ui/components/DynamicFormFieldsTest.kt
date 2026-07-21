package com.tribetails.auntieos.ui.components

import org.junit.Assert.assertEquals
import org.junit.Test

/** Multiselect csv encode/decode used by the dynamic form-field renderer. */
class DynamicFormFieldsTest {

    @Test
    fun parsesTrimmedNonBlankMembers() {
        assertEquals(listOf("a", "b"), multiSelectValues("a, b ,"))
        assertEquals(emptyList<String>(), multiSelectValues(""))
    }

    @Test
    fun toggleAddsWhenAbsent() {
        assertEquals("x", toggleMultiSelect("", "x"))
        assertEquals("a,b", toggleMultiSelect("a", "b"))
    }

    @Test
    fun toggleRemovesWhenPresentPreservingOrder() {
        assertEquals("a,c", toggleMultiSelect("a,b,c", "b"))
        assertEquals("", toggleMultiSelect("x", "x"))
    }
}
