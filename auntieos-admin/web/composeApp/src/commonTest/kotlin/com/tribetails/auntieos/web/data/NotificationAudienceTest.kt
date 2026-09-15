package com.tribetails.auntieos.web.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The ONE audience taxonomy for notification settings (replaces the old NotifTab +
 * NotificationBucket dual system). Tabs and sections are populated purely from
 * [NotificationCatalogEntry.audiences]: a key appears under every audience it serves,
 * legacy single-audience catalogs fall back deterministically, and the legacy mapping
 * can never invent a Staff entry (staff only arrives via the backend audiences object,
 * which never pairs staff with business).
 */
class NotificationAudienceTest {

    private fun entry(audiences: Set<String>) = NotificationCatalogEntry(key = "k", audiences = audiences)

    /**
     * #869: the operator's lockout alert is a business-only `security` row. It
     * appears on the Business tab under Account and security, and on no other tab.
     */
    @Test
    fun operatorLockAlertIsBusinessOnlyUnderAccountAndSecurity() {
        val lock = NotificationCatalogEntry(
            key = "security.account.locked.operator",
            category = "security",
            audiences = setOf("business"),
        )
        assertEquals(setOf(NotifAudience.Business), lock.notifAudiences())
        val grouped = sectionedNotifications(listOf(lock), NotifAudience.Business)
        assertEquals(listOf("Account and security"), grouped.map { it.first.title })
        assertEquals(listOf("security.account.locked.operator"), grouped.single().second.map { it.key })
    }

    /**
     * #877: the operator's failed-login warning is a business-only `security`
     * row, next to the lock alert. It appears on the Business tab under Account
     * and security, and on no other tab.
     */
    @Test
    fun operatorFailedLoginWarningIsBusinessOnlyUnderAccountAndSecurity() {
        val warning = NotificationCatalogEntry(
            key = "security.failedLogin.attempts.operator",
            category = "security",
            audiences = setOf("business"),
        )
        assertEquals(setOf(NotifAudience.Business), warning.notifAudiences())
        val grouped = sectionedNotifications(listOf(warning), NotifAudience.Business)
        assertEquals(listOf("Account and security"), grouped.map { it.first.title })
        assertEquals(listOf("security.failedLogin.attempts.operator"), grouped.single().second.map { it.key })
    }

    /**
     * #891: the operator's two new failed-login signals, a spent report budget
     * and a spike of locks, are business-only `security` rows. They appear on
     * the Business tab under Account and security, and on no other tab.
     */
    @Test
    fun operatorBudgetAndLockSpikeAlertsAreBusinessOnlyUnderAccountAndSecurity() {
        val keys = listOf("security.failedLogin.budgetExhausted.operator", "security.account.locked.spike.operator")
        val entries = keys.map { NotificationCatalogEntry(key = it, category = "security", audiences = setOf("business")) }
        for (e in entries) assertEquals(setOf(NotifAudience.Business), e.notifAudiences(), e.key)
        val grouped = sectionedNotifications(entries, NotifAudience.Business)
        assertEquals(listOf("Account and security"), grouped.map { it.first.title })
        assertEquals(keys.toSet(), grouped.single().second.map { it.key }.toSet())
    }

    @Test
    fun audiencesDriveTheTabsDirectly() {
        assertEquals(setOf(NotifAudience.Business), entry(setOf("business")).notifAudiences())
        assertEquals(setOf(NotifAudience.Staff), entry(setOf("staff")).notifAudiences())
        assertEquals(setOf(NotifAudience.Kinfolk), entry(setOf("kinfolk")).notifAudiences())
    }

    @Test
    fun sharedKeysAppearUnderEachAudienceTheyServe() {
        assertEquals(
            setOf(NotifAudience.Business, NotifAudience.Kinfolk),
            entry(setOf("kinfolk", "business")).notifAudiences(),
        )
        assertEquals(
            setOf(NotifAudience.Staff, NotifAudience.Kinfolk),
            entry(setOf("staff", "kinfolk")).notifAudiences(),
        )
    }

    @Test
    fun legacyAudienceFieldFallsBackWhenAudiencesAbsent() {
        assertEquals(setOf("business"), NotificationCatalogEntry(key = "k", audience = "business").audiences)
        assertEquals(setOf("kinfolk"), NotificationCatalogEntry(key = "k", audience = "kinfolk").audiences)
        assertEquals(setOf("kinfolk", "business"), NotificationCatalogEntry(key = "k", audience = "both").audiences)
        // Case/whitespace tolerant, like the old tab mapping.
        assertEquals(setOf("kinfolk", "business"), NotificationCatalogEntry(key = "k", audience = " Both ").audiences)
    }

    @Test
    fun explicitAudiencesWinOverLegacyField() {
        val e = NotificationCatalogEntry(key = "k", audience = "kinfolk", audiences = setOf("staff"))
        assertEquals(setOf(NotifAudience.Staff), e.notifAudiences())
    }

    @Test
    fun unknownLegacyAudienceIsNeverDropped() {
        assertEquals(setOf("kinfolk"), NotificationCatalogEntry(key = "k", audience = "").audiences)
        assertEquals(setOf("kinfolk"), NotificationCatalogEntry(key = "k", audience = "admin").audiences)
    }

    @Test
    fun legacyFallbackNeverInventsStaff() {
        listOf("business", "kinfolk", "both", "", "weird").forEach { legacy ->
            assertFalse(
                NotifAudience.Staff in NotificationCatalogEntry(key = "k", audience = legacy).notifAudiences(),
                "legacy audience '$legacy' must not map to Staff",
            )
        }
    }

    @Test
    fun sharedCopyCaptionNamesTheOtherCopy() {
        val bk = entry(setOf("business", "kinfolk"))
        assertEquals("Kinfolk get their own copy of this one", sharedCopyCaption(bk, NotifAudience.Business))
        assertEquals("The owner gets their own copy of this one", sharedCopyCaption(bk, NotifAudience.Kinfolk))
        val sk = entry(setOf("staff", "kinfolk"))
        assertEquals("Your Aunties get their own copy of this one", sharedCopyCaption(sk, NotifAudience.Kinfolk))
        assertEquals("Kinfolk get their own copy of this one", sharedCopyCaption(sk, NotifAudience.Staff))
    }

    @Test
    fun sharedCopyCaptionNullForSingleAudienceOrForeignTab() {
        assertNull(sharedCopyCaption(entry(setOf("kinfolk")), NotifAudience.Kinfolk))
        // Entry not shown under this tab at all -> no caption either.
        assertNull(sharedCopyCaption(entry(setOf("business", "kinfolk")), NotifAudience.Staff))
    }

    @Test
    fun alwaysEnabledForCoversEveryStreamWhenUnscoped() {
        val flat = NotificationCatalogEntry(key = "k", alwaysEnabled = true, audiences = setOf("kinfolk", "business"))
        assertTrue(flat.alwaysEnabledFor(STREAM_KINFOLK))
        assertTrue(flat.alwaysEnabledFor(STREAM_BUSINESS))
        assertTrue(flat.alwaysEnabledFor(STREAM_STAFF))
    }

    @Test
    fun alwaysEnabledForRespectsStreamScoping() {
        val scoped = NotificationCatalogEntry(
            key = "k",
            alwaysEnabled = true,
            alwaysEnabledStreams = setOf(STREAM_KINFOLK),
            audiences = setOf("kinfolk", "business"),
        )
        assertTrue(scoped.alwaysEnabledFor(STREAM_KINFOLK))
        assertFalse(scoped.alwaysEnabledFor(STREAM_BUSINESS))
        // Not alwaysEnabled at all -> false everywhere, scoped or not.
        val off = NotificationCatalogEntry(key = "k", alwaysEnabledStreams = setOf(STREAM_KINFOLK))
        assertFalse(off.alwaysEnabledFor(STREAM_KINFOLK))
    }

    @Test
    fun displayTitlePrefersLabelThenDescriptionThenKey() {
        assertEquals("Label", NotificationCatalogEntry(key = "k", label = "Label", description = "Desc").displayTitle())
        assertEquals("Desc", NotificationCatalogEntry(key = "k", description = "Desc").displayTitle())
        assertEquals("k", NotificationCatalogEntry(key = "k").displayTitle())
    }

    private fun cat(key: String, category: String) = NotificationCatalogEntry(key = key, category = category)

    @Test
    fun sectionedNotificationsKeepsSectionAndCatalogOrder() {
        val entries = listOf(
            cat("a", "invoice"),
            cat("b", "visit"),
            cat("c", "messages"),
            cat("d", "visit"),
        )
        val grouped = sectionedNotifications(entries, NotifAudience.Business)
        assertEquals(listOf("Bookings and visits", "Messages", "Billing and payments"), grouped.map { it.first.title })
        // Catalog order preserved inside a section.
        assertEquals(listOf("b", "d"), grouped.first { it.first.title == "Bookings and visits" }.second.map { it.key })
    }

    @Test
    fun sectionedNotificationsDropsEmptySectionsAndNeverDropsEntries() {
        val entries = listOf(
            cat("a", "visit"),
            cat("b", "mystery"),   // unknown category -> trailing Other
            cat("c", ""),          // blank category -> trailing Other
        )
        val grouped = sectionedNotifications(entries, NotifAudience.Staff)
        assertEquals(listOf("Visit workflow", "Other"), grouped.map { it.first.title })
        assertEquals(listOf("b", "c"), grouped.last().second.map { it.key })
        // Every entry landed somewhere.
        assertEquals(entries.size, grouped.sumOf { it.second.size })
    }

    @Test
    fun sectionTaxonomyMatchesEachAudiencesWorkflow() {
        assertEquals(
            listOf("Bookings and visits", "Messages", "Billing and payments", "Ratings and pets", "Account and security"),
            notifSections(NotifAudience.Business).map { it.title },
        )
        assertEquals(
            listOf("Assignments and schedule", "Visit workflow", "KinTales and comments", "Pets and profiles"),
            notifSections(NotifAudience.Staff).map { it.title },
        )
        assertEquals(
            listOf(
                "Visit updates", "Upcoming care", "KinTales", "Billing and payments",
                "Home and pets", "Account and security", "Newsletters and community",
            ),
            notifSections(NotifAudience.Kinfolk).map { it.title },
        )
        // account + security share one section on both hats that show them.
        assertEquals(listOf("account", "security"), notifSections(NotifAudience.Business).last().categories)
    }
}
