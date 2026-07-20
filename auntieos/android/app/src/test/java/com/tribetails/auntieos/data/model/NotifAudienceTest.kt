package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Grouping contract for the revamped gate tabs: one enum, [NotifAudience], driven by
 * the server catalog's `audiences` set (business = owner-hat ops, staff = Auntie-hat
 * workflow, kinfolk = the families' copies). Shared keys appear under EACH of their
 * audiences, with a muted caption naming the other copy.
 */
class NotifAudienceTest {

    @Test
    fun threeAudiencesInFixedOrder() {
        assertEquals(
            listOf(NotifAudience.Business, NotifAudience.Staff, NotifAudience.Kinfolk),
            NotifAudience.entries.sortedBy { it.order },
        )
        assertEquals(STREAM_BUSINESS, NotifAudience.Business.streamKey)
        assertEquals(STREAM_STAFF, NotifAudience.Staff.streamKey)
        assertEquals(STREAM_KINFOLK, NotifAudience.Kinfolk.streamKey)
    }

    @Test
    fun membershipIsDrivenByAudiencesSet() {
        val staffOnly = NotificationCatalogEntry(key = "k", audiences = setOf(STREAM_STAFF))
        assertTrue(staffOnly.inAudience(NotifAudience.Staff))
        assertFalse(staffOnly.inAudience(NotifAudience.Business))
        assertFalse(staffOnly.inAudience(NotifAudience.Kinfolk))
    }

    @Test
    fun sharedKeysAppearInEachAudience() {
        val shared = NotificationCatalogEntry(key = "k", audiences = setOf(STREAM_KINFOLK, STREAM_BUSINESS))
        assertTrue(shared.inAudience(NotifAudience.Business))
        assertTrue(shared.inAudience(NotifAudience.Kinfolk))
        assertFalse(shared.inAudience(NotifAudience.Staff))
    }

    @Test
    fun legacyEntriesGroupThroughAudienceFallback() {
        assertTrue(NotificationCatalogEntry(key = "k", audience = "business").inAudience(NotifAudience.Business))
        val both = NotificationCatalogEntry(key = "k", audience = "both")
        assertTrue(both.inAudience(NotifAudience.Business))
        assertTrue(both.inAudience(NotifAudience.Kinfolk))
        // Unknown legacy audience lands under Kinfolk so nothing disappears.
        assertTrue(NotificationCatalogEntry(key = "k", audience = "").inAudience(NotifAudience.Kinfolk))
    }

    @Test
    fun sharedCopyCaptionNullForSingleAudienceKeys() {
        assertNull(sharedCopyCaption(setOf(STREAM_KINFOLK), NotifAudience.Kinfolk))
        assertNull(sharedCopyCaption(setOf(STREAM_BUSINESS), NotifAudience.Business))
    }

    @Test
    fun sharedCopyCaptionNamesTheOtherCopy() {
        assertEquals(
            "Kinfolk get their own copy (Kinfolk tab).",
            sharedCopyCaption(setOf(STREAM_KINFOLK, STREAM_BUSINESS), NotifAudience.Business),
        )
        assertEquals(
            "You get an owner copy too (Business tab).",
            sharedCopyCaption(setOf(STREAM_KINFOLK, STREAM_BUSINESS), NotifAudience.Kinfolk),
        )
        assertEquals(
            "Kinfolk get their own copy (Kinfolk tab).",
            sharedCopyCaption(setOf(STREAM_KINFOLK, STREAM_STAFF), NotifAudience.Staff),
        )
        assertEquals(
            "You get an Auntie copy too (Auntie tab).",
            sharedCopyCaption(setOf(STREAM_KINFOLK, STREAM_STAFF), NotifAudience.Kinfolk),
        )
    }
}
