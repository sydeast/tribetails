package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The two honesty rules the Template Bank list has to keep, pinned as pure
 * functions because the Android suite is JVM only (no Compose UI test runner
 * here), the same shape [templateBankSearchFilter] and the KinTales
 * `resultCountLabel` already use.
 *
 *  - A category chip must not report a count over templates nobody has read.
 *  - An empty list must say WHICH fact it means: an empty bank, an empty
 *    category, a search that matched nothing, or a read that failed.
 */
class TemplateBankStatesTest {

    // ── chip counts ────────────────────────────────────────────────────────

    @Test
    fun chipLabel_carriesTheCount_onceTemplatesAreLoaded() {
        assertEquals("All (12)", templateBankChipLabel("All", count = 12, loaded = 12, loading = false, hasError = false))
        assertEquals("Bookings (3)", templateBankChipLabel("Bookings", count = 3, loaded = 12, loading = false, hasError = false))
    }

    @Test
    fun chipLabel_saysNoNumberWhileTheFirstReadIsInFlight() {
        assertEquals("All", templateBankChipLabel("All", count = 0, loaded = 0, loading = true, hasError = false))
    }

    @Test
    fun chipLabel_saysNoNumberAfterAFailedRead() {
        // listTemplates() leaves loading false and the list empty, so without
        // this the chip would report "All (0)" about a collection it never
        // managed to read: the confident zero the web side already refuses.
        assertEquals("All", templateBankChipLabel("All", count = 0, loaded = 0, loading = false, hasError = true))
    }

    @Test
    fun chipLabel_keepsTheCountWhenRowsAreAlreadyOnScreen() {
        // A failed REFRESH over twelve visible rows still leaves twelve visible
        // rows, so the chip keeps describing them.
        assertEquals("All (12)", templateBankChipLabel("All", count = 12, loaded = 12, loading = false, hasError = true))
        assertEquals("Bookings (0)", templateBankChipLabel("Bookings", count = 0, loaded = 12, loading = false, hasError = false))
    }

    // ── empty states ───────────────────────────────────────────────────────

    @Test
    fun emptyMessage_anEmptyBankSaysSoAndPointsAtTheWebAdmin() {
        // #953 7a: Android creates no templates any more; new ones start on the web editor.
        assertEquals(
            "No templates yet. Create one on the web admin.",
            templateBankEmptyMessage(loaded = 0, category = "All", query = "", hasError = false),
        )
    }

    @Test
    fun emptyMessage_aFailedReadIsNotAnEmptyBank() {
        assertEquals(
            "Templates could not be loaded. See the error above.",
            templateBankEmptyMessage(loaded = 0, category = "All", query = "", hasError = true),
        )
    }

    @Test
    fun emptyMessage_anEmptyCategoryNamesTheCategory() {
        assertEquals(
            "No templates in Bookings.",
            templateBankEmptyMessage(loaded = 12, category = "Bookings", query = "", hasError = false),
        )
    }

    @Test
    fun emptyMessage_aSearchThatMatchedNothingIsNotAnEmptyCategory() {
        // The old copy said "No templates in this category." even on All with a
        // query typed, which named the wrong exclusion.
        assertEquals(
            "Nothing matches \"refund\". Searched all 12 templates, by title and key.",
            templateBankEmptyMessage(loaded = 12, category = "All", query = "refund", hasError = false),
        )
    }

    @Test
    fun emptyMessage_carriesBothExclusionsWhenBothAreOn() {
        assertEquals(
            "Nothing in Bookings matches \"refund\". Searched all 12 templates, by title and key.",
            templateBankEmptyMessage(loaded = 12, category = "Bookings", query = "refund", hasError = false),
        )
    }

    @Test
    fun emptyMessage_reportsTheQueryTrimmed() {
        assertEquals(
            "Nothing matches \"refund\". Searched all 1 template, by title and key.",
            templateBankEmptyMessage(loaded = 1, category = "All", query = "  refund  ", hasError = false),
        )
    }

    @Test
    fun emptyMessage_saysAllBecauseThisConsoleReadsTheWholeCollection() {
        // listTemplates() is called with no limit here (TemplateRepository), so
        // unlike the paged web bank the search really did cover everything.
        assertEquals(
            "Nothing matches \"zzz\". Searched all 2 templates, by title and key.",
            templateBankEmptyMessage(loaded = 2, category = "All", query = "zzz", hasError = false),
        )
    }
}
