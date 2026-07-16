package com.tribetails.auntieos.ui.branding

import com.tribetails.auntieos.data.model.BusinessSettings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 17.2 Branding pure-helper tests (android). Mirror of the web BrandingTest.
 * Covers blank-fallback (no regression), operator overrides, punctuation/whitespace
 * edge cases, field-isolation on merge, and dirty detection.
 */
class BrandingTest {

    // ---- homeHeading ----

    @Test
    fun homeHeading_blank_settings_uses_time_default_and_Auntie_tail() {
        val h = homeHeading(BusinessSettings(), defaultGreeting = "Good Morning")
        assertEquals("Good Morning,", h.title)
        assertEquals("Auntie.", h.accentTail)
    }

    @Test
    fun homeHeading_operator_override_replaces_greeting_and_tail() {
        val h = homeHeading(
            BusinessSettings(homeGreeting = "Welcome back", homeAccentTail = "Team"),
            defaultGreeting = "Good Morning",
        )
        assertEquals("Welcome back,", h.title)
        assertEquals("Team", h.accentTail)
    }

    @Test
    fun homeHeading_does_not_double_punctuation() {
        val h = homeHeading(BusinessSettings(homeGreeting = "Hello!"), defaultGreeting = "Good Morning")
        assertEquals("Hello!", h.title)
    }

    @Test
    fun homeHeading_trims_surrounding_whitespace() {
        val h = homeHeading(BusinessSettings(homeGreeting = "  Hi  "), defaultGreeting = "Good Morning")
        assertEquals("Hi,", h.title)
    }

    @Test
    fun homeHeading_blank_greeting_falls_back_even_when_only_tail_set() {
        val h = homeHeading(BusinessSettings(homeAccentTail = "Boss"), defaultGreeting = "Good Evening")
        assertEquals("Good Evening,", h.title)
        assertEquals("Boss", h.accentTail)
    }

    // ---- brandIdentity ----

    @Test
    fun brandIdentity_blank_settings_uses_shipped_defaults() {
        val b = brandIdentity(BusinessSettings())
        assertEquals("", b.logoUrl)
        assertEquals("AuntieOS", b.wordmark)
        assertEquals("Tribe Tails Care", b.tagline)
    }

    @Test
    fun brandIdentity_uses_and_trims_operator_values() {
        val b = brandIdentity(
            BusinessSettings(
                logoUrl = "  https://cdn/x.png  ",
                brandWordmark = "Happy Paws",
                brandTagline = "Pet Care Co",
            ),
        )
        assertEquals("https://cdn/x.png", b.logoUrl)
        assertEquals("Happy Paws", b.wordmark)
        assertEquals("Pet Care Co", b.tagline)
    }

    // ---- withBranding ----

    @Test
    fun withBranding_overlays_branding_and_preserves_sibling_fields() {
        val loaded = BusinessSettings(businessName = "Tribe Tails", calendarSyncId = "cal-123")
        val edited = loaded.withBranding(
            logoUrl = " https://cdn/logo.png ",
            wordmark = " Happy Paws ",
            tagline = " Care ",
            greeting = " Hi ",
            accentTail = " Pal ",
        )
        assertEquals("https://cdn/logo.png", edited.logoUrl)
        assertEquals("Happy Paws", edited.brandWordmark)
        assertEquals("Care", edited.brandTagline)
        assertEquals("Hi", edited.homeGreeting)
        assertEquals("Pal", edited.homeAccentTail)
        // siblings untouched (merge-safe)
        assertEquals("Tribe Tails", edited.businessName)
        assertEquals("cal-123", edited.calendarSyncId)
    }

    // ---- brandingDirty ----

    @Test
    fun brandingDirty_false_when_identical() {
        val s = BusinessSettings(brandWordmark = "AuntieOS")
        assertFalse(brandingDirty(s, s))
    }

    @Test
    fun brandingDirty_true_when_any_branding_field_changes() {
        val loaded = BusinessSettings()
        assertTrue(brandingDirty(loaded, loaded.copy(logoUrl = "u")))
        assertTrue(brandingDirty(loaded, loaded.copy(brandWordmark = "w")))
        assertTrue(brandingDirty(loaded, loaded.copy(brandTagline = "t")))
        assertTrue(brandingDirty(loaded, loaded.copy(homeGreeting = "g")))
        assertTrue(brandingDirty(loaded, loaded.copy(homeAccentTail = "a")))
    }

    @Test
    fun brandingDirty_ignores_non_branding_field_changes() {
        val loaded = BusinessSettings()
        assertFalse(brandingDirty(loaded, loaded.copy(businessName = "changed")))
    }
}
