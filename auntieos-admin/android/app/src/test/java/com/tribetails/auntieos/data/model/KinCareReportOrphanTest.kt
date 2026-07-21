package com.tribetails.auntieos.data.model

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for the `KinCareReport.isUntriagedOrphan()` helper.
 *
 * Pre-conditions of an "untriaged orphan" (post May-17 migration):
 *   • `kinfolkId` is blank  (couldn't auto-link during import)
 *   • `triageStatus` is blank (admin hasn't acted yet)
 *   • `sentVia` is one of: "legacy_orphan", "legacy_visit_logs"
 *
 * All three must hold simultaneously. Any deviation means the row should not
 * be lifted into the Needs Triage section.
 */
class KinCareReportOrphanTest {

    private fun report(
        kinfolkId: String = "",
        triageStatus: String = "",
        sentVia: String = "",
    ): KinCareReport = KinCareReport(
        id = "legacy_79",
    ).also {
        it.kinfolkId = kinfolkId
        it.triageStatus = triageStatus
        it.sentVia = sentVia
    }

    @Test
    fun `legacy_visit_logs with no kinfolk and no triage is an untriaged orphan`() {
        val r = report(sentVia = "legacy_visit_logs")
        assertTrue(r.isUntriagedOrphan())
    }

    @Test
    fun `legacy_orphan (Pass 1 label) with no kinfolk and no triage is also an untriaged orphan`() {
        val r = report(sentVia = "legacy_orphan")
        assertTrue(r.isUntriagedOrphan())
    }

    @Test
    fun `untriaged orphan with kinfolk assigned is not orphan anymore`() {
        val r = report(kinfolkId = "kf1", sentVia = "legacy_visit_logs")
        assertFalse(r.isUntriagedOrphan())
    }

    @Test
    fun `assigned triage status hides row from triage section even with blank kinfolkId`() {
        // Defensive: in practice the assign action also fills kinfolkId, but we
        // require both signals so a partial write doesn't double-list.
        val r = report(triageStatus = "assigned", sentVia = "legacy_visit_logs")
        assertFalse(r.isUntriagedOrphan())
    }

    @Test
    fun `duplicate triage status hides row from triage section`() {
        val r = report(triageStatus = "duplicate", sentVia = "legacy_visit_logs")
        assertFalse(r.isUntriagedOrphan())
    }

    @Test
    fun `archived_bad_data triage status hides row from triage section`() {
        val r = report(triageStatus = "archived_bad_data", sentVia = "legacy_visit_logs")
        assertFalse(r.isUntriagedOrphan())
    }

    @Test
    fun `normal SMS report with kinfolk is not an orphan`() {
        val r = report(kinfolkId = "kf1", sentVia = "sms")
        assertFalse(r.isUntriagedOrphan())
    }

    @Test
    fun `blank sentVia is not enough - only the migration sentinel values count`() {
        // A truly empty report (draft, never sent) should NOT appear in triage -
        // the catalog of orphan sentinels is closed (legacy_orphan +
        // legacy_visit_logs). Empty drafts belong in the Drafts bucket.
        val r = report(sentVia = "")
        assertFalse(r.isUntriagedOrphan())
    }

    @Test
    fun `unrelated sentVia (e g email) is not an orphan even with blank kinfolkId`() {
        val r = report(sentVia = "email")
        assertFalse(r.isUntriagedOrphan())
    }

    @Test
    fun `case sensitivity - sentVia comparison is exact (uppercase not matched)`() {
        // Migration writes lowercase; defend against accidental upper-case
        // sentinels being treated as orphans.
        val r = report(sentVia = "LEGACY_VISIT_LOGS")
        assertFalse(r.isUntriagedOrphan())
    }
}
