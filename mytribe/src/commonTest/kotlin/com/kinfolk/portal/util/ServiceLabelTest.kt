package com.kinfolk.portal.util
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
/** #1297: the portal prints the server-resolved service name, never a code. */
class ServiceLabelTest {
    @Test
    fun `tells a code from a name`() {
        assertTrue(looksLikeServiceCode("visit_60"))
        assertTrue(looksLikeServiceCode("VISIT_60"))
        assertFalse(looksLikeServiceCode("30 Minute Quick Check"))
        assertFalse(looksLikeServiceCode("Overnight"))
    }
    @Test
    fun `decodes the sent label, and falls back only to a raw name`() {
        assertEquals("60 Minute", decodeServiceLabel(true, "60 Minute", "visit_60"))
        assertNull(decodeServiceLabel(true, null, "visit_60"))
        assertNull(decodeServiceLabel(false, null, "visit_60"))
        assertEquals("Overnight", decodeServiceLabel(false, null, "Overnight"))
    }
    @Test
    fun `title and eyebrow carry no code and no prefix`() {
        assertEquals("60 Minute", visitTitle("visit_60", "60 Minute"))
        assertEquals("Midday drop-in", visitTitle("Midday drop-in", "60 Minute"))
        assertEquals("60 Minute", serviceEyebrow("Midday drop-in", "60 Minute"))
        assertNull(serviceEyebrow(null, "60 Minute"))
        assertNull(serviceEyebrow("Midday drop-in", null))
    }
}
