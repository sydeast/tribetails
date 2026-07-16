package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Workflow-section grouping contract (shared by the gate matrix + prefs screens):
 * ordered sections of catalog categories per stream, entries kept in incoming order
 * inside each section, unmatched categories collected in a trailing "Other" section,
 * empty sections omitted, and nothing ever dropped.
 */
class NotifSectionTest {

    private fun entry(key: String, category: String) =
        NotificationCatalogEntry(key = key, category = category)

    @Test
    fun sectionOrderMatchesTaxonomyPerStream() {
        assertEquals(
            listOf(
                "Bookings and visits", "Messages", "Billing and payments",
                "Ratings and pets", "Account and security",
            ),
            notifSectionsFor(STREAM_BUSINESS).map { it.title },
        )
        assertEquals(
            listOf(
                "Assignments and schedule", "Visit workflow",
                "KinTales and comments", "Pets and profiles",
            ),
            notifSectionsFor(STREAM_STAFF).map { it.title },
        )
        assertEquals(
            listOf(
                "Visit updates", "Upcoming care", "KinTales", "Billing and payments",
                "Home and pets", "Account and security", "Newsletters and community",
            ),
            notifSectionsFor(STREAM_KINFOLK).map { it.title },
        )
    }

    @Test
    fun groupsInSectionOrderAndKeepsEntryOrderWithinSections() {
        val entries = listOf(
            entry("sec.breach", "security"),
            entry("visit.report", "visit"),
            entry("acct.reset", "account"),
            entry("visit.arrived", "visit"),
            entry("msg.received", "messages"),
        )
        val grouped = sectionedNotifEntries(entries, STREAM_BUSINESS)
        assertEquals(
            listOf("Bookings and visits", "Messages", "Account and security"),
            grouped.map { it.first },
        )
        // Incoming order preserved inside a section.
        assertEquals(
            listOf("visit.report", "visit.arrived"),
            grouped.first { it.first == "Bookings and visits" }.second.map { it.key },
        )
        // account + security both land under "Account and security", still in order.
        assertEquals(
            listOf("sec.breach", "acct.reset"),
            grouped.first { it.first == "Account and security" }.second.map { it.key },
        )
    }

    @Test
    fun unmatchedCategoriesLandInTrailingOtherAndNothingIsDropped() {
        val entries = listOf(
            entry("visit.report", "visit"),
            entry("weird.one", "mystery"),
            entry("blank.one", ""),
        )
        val grouped = sectionedNotifEntries(entries, STREAM_KINFOLK)
        assertEquals(listOf("Visit updates", NOTIF_SECTION_OTHER), grouped.map { it.first })
        assertEquals(
            listOf("weird.one", "blank.one"),
            grouped.last().second.map { it.key },
        )
        // Nothing dropped: every entry appears exactly once.
        assertEquals(entries.size, grouped.sumOf { it.second.size })
    }

    @Test
    fun emptySectionsAreOmittedAndNoOtherWhenAllMatch() {
        val grouped = sectionedNotifEntries(listOf(entry("kt.new", "kintale")), STREAM_STAFF)
        assertEquals(listOf("KinTales and comments"), grouped.map { it.first })
    }

    @Test
    fun unknownStreamPutsEverythingUnderOther() {
        val grouped = sectionedNotifEntries(listOf(entry("visit.report", "visit")), "nope")
        assertEquals(listOf(NOTIF_SECTION_OTHER), grouped.map { it.first })
        assertEquals(listOf("visit.report"), grouped.single().second.map { it.key })
    }

    @Test
    fun noEntriesMeansNoSections() {
        assertTrue(sectionedNotifEntries(emptyList(), STREAM_BUSINESS).isEmpty())
    }

    @Test
    fun sameCategoryGroupsDifferentlyPerStream() {
        val visits = listOf(entry("visit.report", "visit"))
        assertEquals("Bookings and visits", sectionedNotifEntries(visits, STREAM_BUSINESS).single().first)
        assertEquals("Visit workflow", sectionedNotifEntries(visits, STREAM_STAFF).single().first)
        assertEquals("Visit updates", sectionedNotifEntries(visits, STREAM_KINFOLK).single().first)
    }
}
