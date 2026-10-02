package com.tribetails.auntieos.data.model
import org.junit.Assert.assertEquals
import org.junit.Test
/**
 * #1109: one default business zone. A `business_settings` document with no
 * `timeZone` reads as America/Chicago here, on the server (`businessTimeZone`)
 * and on the admin web (`resolveBusinessTimeZone`), so an overnight start time
 * is read on the same night everywhere.
 */
class BusinessTimeZoneTest {
    @Test
    fun `the default is America Chicago, the operator ruling of 2026-08-11`() {
        assertEquals("America/Chicago", DEFAULT_BUSINESS_TIME_ZONE)
    }
    @Test
    fun `a settings document with no zone has a blank zone and resolves to the default`() {
        val s = BusinessSettings()
        assertEquals("", s.timeZone)
        assertEquals("America/Chicago", resolveBusinessTimeZone(s.timeZone))
    }
    @Test
    fun `a stored zone this device can read wins, trimmed`() {
        assertEquals("America/Los_Angeles", resolveBusinessTimeZone(" America/Los_Angeles "))
    }
    @Test
    fun `a missing, blank or unreadable zone resolves to the default`() {
        assertEquals("America/Chicago", resolveBusinessTimeZone(null))
        assertEquals("America/Chicago", resolveBusinessTimeZone(""))
        assertEquals("America/Chicago", resolveBusinessTimeZone("   "))
        assertEquals("America/Chicago", resolveBusinessTimeZone("Mars/Olympus"))
    }
}
