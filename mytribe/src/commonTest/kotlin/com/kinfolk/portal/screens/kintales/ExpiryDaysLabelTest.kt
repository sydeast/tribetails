package com.kinfolk.portal.screens.kintales

import kotlin.test.Test
import kotlin.test.assertEquals

/** #1900: the Share dialog's expiry chip read "1 Days" at the slider's lowest value. */
class ExpiryDaysLabelTest {
    @Test
    fun oneDayIsSingular() {
        assertEquals("1 Day", expiryDaysLabel(1))
    }

    @Test
    fun everyOtherValueIsPlural() {
        assertEquals("2 Days", expiryDaysLabel(2))
        assertEquals("7 Days", expiryDaysLabel(7))
        assertEquals("90 Days", expiryDaysLabel(90))
    }
}
