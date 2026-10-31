package com.tribetails.auntieos.ui.admin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
class SchedulingOptionsLabelTest {
    @Test
    fun surchargeLineStatesTheCount() {
        assertEquals("Active surcharges: 0", activeSurchargesLabel(0))
        assertEquals("Active surcharges: 3", activeSurchargesLabel(3))
    }
    @Test
    fun surchargeLineDoesNotPromiseInvoiceOrHolidayUse() {
        val label = activeSurchargesLabel(2).lowercase()
        assertFalse(label.contains("holiday"))
        assertFalse(label.contains("invoice"))
        assertFalse(label.contains("applied"))
    }

    @Test
    fun surchargeButtonIsNamedForWhatItDoes() {
        assertEquals("Manage Surcharges", MANAGE_SURCHARGES_LABEL)
        assertFalse(MANAGE_SURCHARGES_LABEL.contains("Link"))
    }
}
