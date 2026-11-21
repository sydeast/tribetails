package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * #2268: a visit's stored status reads the way the server reads it. A called-off
 * visit is stored as `CANCELLED`, `cancelled` or the one-L `CANCELED`, and all
 * three are cancelled on every screen.
 */
class VisitStatusCodeTest {

    @Test
    fun `every stored spelling of a cancellation is the CANCELLED code`() {
        for (raw in listOf("CANCELLED", "cancelled", "CANCELED", "canceled", "  CANCELED ")) {
            assertEquals(raw, "CANCELLED", visitStatusCode(raw))
        }
    }

    @Test
    fun `other codes are only trimmed and upper-cased, an unknown one keeps its own text`() {
        assertEquals("SCHEDULED", visitStatusCode("scheduled"))
        assertEquals("ON_MY_WAY", visitStatusCode(" on_my_way "))
        assertEquals("NO_SHOW", visitStatusCode("no_show"))
        assertEquals("", visitStatusCode(null))
        assertEquals("", visitStatusCode("   "))
    }

    @Test
    fun `fromStored names the enum for a known code and null for an unknown one`() {
        assertEquals(VisitStatus.CANCELLED, VisitStatus.fromStored("CANCELED"))
        assertEquals(VisitStatus.CANCELLED, VisitStatus.fromStored("cancelled"))
        assertEquals(VisitStatus.ARRIVED, VisitStatus.fromStored("arrived"))
        assertEquals(VisitStatus.SCHEDULED, VisitStatus.fromStored("SCHEDULED"))
        assertNull(VisitStatus.fromStored("NO_SHOW"))
        assertNull(VisitStatus.fromStored(""))
        assertNull(VisitStatus.fromStored(null))
    }
}
