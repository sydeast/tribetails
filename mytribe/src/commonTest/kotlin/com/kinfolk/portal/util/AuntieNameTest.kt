package com.kinfolk.portal.util
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
class AuntieNameTest {
    @Test
    fun plainName_getsTheRoleWord() {
        assertEquals("Auntie Maya", auntieName("Maya"))
    }
    @Test
    fun nameThatAlreadySaysAuntie_isLeftAlone() {
        assertEquals("TEST SANDBOX Auntie", auntieName("TEST SANDBOX Auntie"))
        assertEquals("Auntie Maya", auntieName("Auntie Maya"))
        assertEquals("auntie maya", auntieName("auntie maya"))
        assertEquals("Auntie", auntieName("Auntie"))
    }
    @Test
    fun matchesTheWholeWordOnly() {
        assertEquals("Auntie Aunties Club", auntieName("Aunties Club"))
    }
    @Test
    fun blankOrMissing_isNull() {
        assertNull(auntieName(null))
        assertNull(auntieName(""))
        assertNull(auntieName("   "))
    }
}
