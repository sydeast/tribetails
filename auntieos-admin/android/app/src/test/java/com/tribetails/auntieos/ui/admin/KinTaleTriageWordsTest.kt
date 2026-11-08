package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.KinCareReport
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/** #1592: Needs triage names an orphan by when and whose it is, never by its document id. */
class KinTaleTriageWordsTest {

    private val orphan = KinCareReport(id = "legacy_79", createdAt = "2026-05-17T10:00:00Z")

    @Test fun anOrphanRowLeadsWithWhenItWasWritten() {
        assertEquals("May 17 · 10:00", orphanWhen(orphan, 2026))
        assertEquals("Date TBD", orphanWhen(KinCareReport(id = "legacy_80"), 2026))
    }

    @Test fun aDuplicateCandidateIsWhoseAndWhen() {
        val canon = KinCareReport(id = "tale1", kinfolkName = "The Whitfields", visitDate = "2025-09-03T14:02:00Z")
        assertEquals("The Whitfields · Sep 3, 2025 · 14:02", duplicateCandidateLabel(canon, 2026))
        assertEquals("Unnamed Kinfolk · Date TBD", duplicateCandidateLabel(KinCareReport(id = "tale2"), 2026))
    }

    @Test fun theDialogsNameNoIdAndNoDatabase() {
        listOf(TRIAGE_ASSIGN_TITLE, TRIAGE_DUPLICATE_TITLE, TRIAGE_ARCHIVE_TITLE, TRIAGE_ARCHIVE_HINT).forEach { text ->
            assertFalse(text, text.contains("legacy_"))
            assertFalse(text, text.contains("Firestore"))
            assertFalse(text, text.contains("activity_log"))
        }
    }
}
