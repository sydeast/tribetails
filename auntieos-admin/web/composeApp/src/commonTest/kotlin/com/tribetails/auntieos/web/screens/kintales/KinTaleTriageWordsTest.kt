package com.tribetails.auntieos.web.screens.kintales

import com.tribetails.auntieos.web.data.KinCareReport
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/** #1592: Needs triage names an orphan by when and whose it is, never by its document id. */
class KinTaleTriageWordsTest {

    @Test
    fun anOrphanRowLeadsWithWhenItWasWritten() {
        assertEquals("May 17 · 10:00", reportWhen(KinCareReport(_id = "legacy_79", createdAt = "2026-05-17T10:00:00Z"), 2026))
        assertEquals("Date TBD", reportWhen(KinCareReport(_id = "legacy_80"), 2026))
    }

    @Test
    fun aDuplicateCandidateIsWhoseAndWhen() {
        val canon = KinCareReport(_id = "tale1", kinfolkName = "The Whitfields", visitDate = "2025-09-03T14:02:00Z")
        assertEquals("The Whitfields · Sep 3, 2025 · 14:02", duplicateCandidateLabel(canon, 2026))
        assertEquals("Unnamed Kinfolk · Date TBD", duplicateCandidateLabel(KinCareReport(_id = "tale2"), 2026))
    }

    @Test
    fun theDialogsNameNoIdAndNoDatabase() {
        for (text in listOf(TRIAGE_ASSIGN_TITLE, TRIAGE_DUPLICATE_TITLE, TRIAGE_ARCHIVE_TITLE, TRIAGE_ARCHIVE_HINT)) {
            assertFalse(text.contains("legacy_"), text)
            assertFalse(text.contains("activity_log"), text)
            assertFalse(text.contains("doc"), text)
        }
    }
}
