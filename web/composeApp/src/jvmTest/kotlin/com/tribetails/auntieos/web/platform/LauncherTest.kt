package com.tribetails.auntieos.web.platform

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class LauncherTest {
    @Test fun telUri_stripsFormattingKeepsDigits() {
        assertEquals("tel:5550142231", telUri("(555) 014-2231"))
        assertEquals("tel:5550142231", telUri("555.014.2231"))
    }

    @Test fun telUri_keepsLeadingPlus() {
        assertEquals("tel:+15550142231", telUri("+1 (555) 014-2231"))
    }

    @Test fun telUri_nullWhenNoDigits() {
        assertNull(telUri(""))
        assertNull(telUri("   "))
        assertNull(telUri("not a phone"))
    }

    @Test fun smsUri_usesSmsScheme() {
        assertEquals("sms:5550142231", smsUri("555-014-2231"))
        assertNull(smsUri("nope"))
    }
}
