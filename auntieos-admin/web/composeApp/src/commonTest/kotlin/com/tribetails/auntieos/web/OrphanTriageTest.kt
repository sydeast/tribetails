package com.tribetails.auntieos.web

import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.isUntriagedOrphan
import com.tribetails.auntieos.web.screens.kintales.bodyPreview
import com.tribetails.auntieos.web.screens.kintales.partitionForDisplay
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Unit tests for the May-17 KinCareReport orphan-triage helpers.
 *
 * The orphan-triage UI on the KinTale Logs screen depends on:
 *  - [isUntriagedOrphan] correctly identifying which reports need attention
 *  - [partitionForDisplay] keeping triaged docs out of BOTH the orphan section
 *    and the main buckets (per Pass-2 spec)
 *  - [bodyPreview] producing a stable, single-line preview cap of ~80 chars
 *
 * If the dispatcher of legacy_visit_logs / legacy_orphan markers changes, these
 * tests will break - that's intended; update [isUntriagedOrphan] first.
 */
class OrphanTriageTest {

    private fun report(
        id: String = "r1",
        kinfolkId: String = "",
        sentVia: String = "",
        triageStatus: String = "",
        body: String = "",
    ): KinCareReport = KinCareReport(
        _id = id,
        kinfolkId = kinfolkId,
        sentVia = sentVia,
        triageStatus = triageStatus,
        bodyCopy = body,
    )

    // ---------- isUntriagedOrphan ----------

    @Test
    fun isUntriagedOrphan_trueFor_legacyVisitLogs_blankKinfolk_blankTriage() {
        val r = report(sentVia = "legacy_visit_logs")
        assertTrue(r.isUntriagedOrphan())
    }

    @Test
    fun isUntriagedOrphan_trueFor_legacyOrphan_blankKinfolk_blankTriage() {
        // The legacy "legacy_orphan" marker was renamed to "legacy_visit_logs"
        // during Pass 2 - but any doc still carrying the old marker is still
        // an orphan that needs triage.
        val r = report(sentVia = "legacy_orphan")
        assertTrue(r.isUntriagedOrphan())
    }

    @Test
    fun isUntriagedOrphan_falseWhen_kinfolkIdPresent() {
        val r = report(kinfolkId = "kf_1", sentVia = "legacy_visit_logs")
        assertFalse(r.isUntriagedOrphan())
    }

    @Test
    fun isUntriagedOrphan_falseWhen_triageStatusSet_assigned() {
        val r = report(sentVia = "legacy_visit_logs", triageStatus = "assigned")
        assertFalse(r.isUntriagedOrphan())
    }

    @Test
    fun isUntriagedOrphan_falseWhen_triageStatusSet_duplicate() {
        val r = report(sentVia = "legacy_visit_logs", triageStatus = "duplicate")
        assertFalse(r.isUntriagedOrphan())
    }

    @Test
    fun isUntriagedOrphan_falseWhen_triageStatusSet_archived() {
        val r = report(sentVia = "legacy_visit_logs", triageStatus = "archived_bad_data")
        assertFalse(r.isUntriagedOrphan())
    }

    @Test
    fun isUntriagedOrphan_falseFor_normalSentVia() {
        // Real production reports use sentVia values like "email", "sms", or "web" -
        // those must never be treated as orphans even with blank kinfolkId
        // (which would itself be a data error worth flagging separately).
        listOf("email", "sms", "web", "", "manual").forEach { via ->
            val r = report(sentVia = via)
            assertFalse(r.isUntriagedOrphan(), "Expected non-orphan for sentVia=\"$via\"")
        }
    }

    @Test
    fun isUntriagedOrphan_falseFor_defaultReport() {
        // Brand-new draft created in the admin UI has blank everything by
        // default - must NOT be flagged as an orphan.
        assertFalse(KinCareReport().isUntriagedOrphan())
    }

    // ---------- partitionForDisplay ----------

    @Test
    fun partition_separatesOrphansFromRest() {
        val orphan = report(id = "legacy_79", sentVia = "legacy_visit_logs")
        val normal = report(id = "r1", kinfolkId = "kf_1", sentVia = "email")
        val (orphans, rest) = partitionForDisplay(listOf(orphan, normal))
        assertEquals(listOf("legacy_79"), orphans.map { it._id })
        assertEquals(listOf("r1"), rest.map { it._id })
    }

    @Test
    fun partition_filtersOut_triagedReports_fromBothBuckets() {
        // Once a report has been triaged (any non-blank triageStatus), it must
        // disappear from BOTH the orphan section and the main buckets - its
        // information is preserved on the doc for audit but the operator never
        // needs to see it again.
        val assigned  = report(id = "a", sentVia = "legacy_visit_logs", triageStatus = "assigned", kinfolkId = "kf_1")
        val duplicate = report(id = "b", sentVia = "legacy_visit_logs", triageStatus = "duplicate")
        val archived  = report(id = "c", sentVia = "legacy_visit_logs", triageStatus = "archived_bad_data")
        val normal    = report(id = "n", kinfolkId = "kf_2", sentVia = "email")

        val (orphans, rest) = partitionForDisplay(listOf(assigned, duplicate, archived, normal))
        assertTrue(orphans.isEmpty(), "Triaged reports must not appear in orphan bucket")
        assertEquals(listOf("n"), rest.map { it._id })
    }

    @Test
    fun partition_emptyList_emptyResult() {
        val (orphans, rest) = partitionForDisplay(emptyList())
        assertTrue(orphans.isEmpty())
        assertTrue(rest.isEmpty())
    }

    @Test
    fun partition_multipleOrphans_preservesOrder() {
        val o1 = report(id = "legacy_79", sentVia = "legacy_visit_logs")
        val o2 = report(id = "legacy_80", sentVia = "legacy_orphan")
        val o3 = report(id = "legacy_81", sentVia = "legacy_visit_logs")
        val (orphans, _) = partitionForDisplay(listOf(o1, o2, o3))
        assertEquals(listOf("legacy_79", "legacy_80", "legacy_81"), orphans.map { it._id })
    }

    // ---------- bodyPreview ----------

    @Test
    fun bodyPreview_collapsesWhitespace() {
        val raw = "Line one\nLine\ttwo\n\nLine three"
        assertEquals("Line one Line two Line three", bodyPreview(raw))
    }

    @Test
    fun bodyPreview_truncatesPast80Chars() {
        val raw = "a".repeat(120)
        val p = bodyPreview(raw)
        assertEquals(81, p.length)         // 80 + ellipsis
        assertTrue(p.endsWith("…"))
    }

    @Test
    fun bodyPreview_blankBecomesPlaceholder() {
        assertEquals("(empty body)", bodyPreview(""))
        assertEquals("(empty body)", bodyPreview("   \n\t  "))
    }

    @Test
    fun bodyPreview_shortBodyUnchanged() {
        assertEquals("Short body.", bodyPreview("Short body."))
    }
}
