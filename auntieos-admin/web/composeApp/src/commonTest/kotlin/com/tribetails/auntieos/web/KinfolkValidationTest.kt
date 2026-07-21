package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.Kinfolk
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class KinfolkValidationTest {

    // ── displayName computed property ─────────────────────────────────────────

    @Test
    fun displayName_combines_first_and_last() {
        val kf = Kinfolk(firstName = "Priya", lastName = "Harris")
        assertEquals("Priya Harris", kf.displayName)
    }

    @Test
    fun displayName_first_only_no_trailing_space() {
        val kf = Kinfolk(firstName = "Priya", lastName = "")
        assertEquals("Priya", kf.displayName)
    }

    @Test
    fun displayName_last_only_no_leading_space() {
        val kf = Kinfolk(firstName = "", lastName = "Harris")
        assertEquals("Harris", kf.displayName)
    }

    @Test
    fun displayName_both_blank_returns_fallback() {
        val kf = Kinfolk(firstName = "", lastName = "")
        assertEquals("Unnamed Kinfolk", kf.displayName)
    }

    @Test
    fun displayName_whitespace_only_returns_fallback() {
        val kf = Kinfolk(firstName = "   ", lastName = "  ")
        assertEquals("Unnamed Kinfolk", kf.displayName)
    }

    // ── Status defaults ───────────────────────────────────────────────────────

    @Test
    fun default_status_is_active() {
        val kf = Kinfolk()
        assertEquals("active", kf.status)
    }

    @Test
    fun status_can_be_inactive() {
        val kf = Kinfolk(status = "inactive")
        assertEquals("inactive", kf.status)
    }

    @Test
    fun status_can_be_archived() {
        val kf = Kinfolk(status = "archived")
        assertEquals("archived", kf.status)
    }

    // ── Field defaults ────────────────────────────────────────────────────────

    @Test
    fun default_phone_is_blank() {
        val kf = Kinfolk()
        assertTrue(kf.phoneNumber.isBlank())
    }

    @Test
    fun default_email_is_blank() {
        val kf = Kinfolk()
        assertTrue(kf.email.isBlank())
    }

    @Test
    fun default_outstanding_balance_is_zero_string() {
        val kf = Kinfolk()
        assertEquals("0.00", kf.outstandingBalance)
    }

    @Test
    fun default_tags_empty() {
        val kf = Kinfolk()
        assertTrue(kf.tags.isEmpty())
    }

    @Test
    fun default_preferred_contact_method_is_Text() {
        val kf = Kinfolk()
        assertEquals("Text", kf.preferredContactMethod)
    }

    // ── Required field validation (pure logic) ────────────────────────────────

    @Test
    fun kinfolk_missing_firstName_is_detectable() {
        val kf = Kinfolk(firstName = "", lastName = "Harris")
        assertTrue(kf.firstName.isBlank())
    }

    @Test
    fun kinfolk_with_firstName_passes_required_check() {
        val kf = Kinfolk(firstName = "Priya", lastName = "Harris")
        assertFalse(kf.firstName.isBlank())
    }

    // ── Unicode / international names ─────────────────────────────────────────

    @Test
    fun displayName_handles_unicode_characters() {
        val kf = Kinfolk(firstName = "Zoë", lastName = "Müller")
        assertEquals("Zoë Müller", kf.displayName)
    }

    @Test
    fun displayName_handles_hyphenated_last_name() {
        val kf = Kinfolk(firstName = "Sarah", lastName = "Smith-Jones")
        assertEquals("Sarah Smith-Jones", kf.displayName)
    }

    // ── Edge cases ────────────────────────────────────────────────────────────

    @Test
    fun _id_defaults_to_blank() {
        val kf = Kinfolk()
        assertTrue(kf._id.isBlank())
    }

    @Test
    fun copy_preserves_all_fields() {
        val original = Kinfolk(
            _id = "k1", firstName = "Priya", lastName = "Harris",
            phoneNumber = "5551234567", email = "m@example.com", status = "active",
        )
        val copy = original.copy(status = "inactive")
        assertEquals("Priya", copy.firstName)
        assertEquals("Harris", copy.lastName)
        assertEquals("inactive", copy.status)
        assertEquals("k1", copy._id)
    }

    @Test
    fun contact_override_defaults_to_null() {
        val kf = Kinfolk()
        assertEquals(null, kf.contactOverride)
    }
}
