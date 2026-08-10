package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.reflect.Modifier

/**
 * The KinTale differ itself, away from any ViewModel.
 *
 * `kin_care_reports/{id}` has four writers - this editor, `markReportSent`, the
 * `triageOrphanReport` callable and the repository's own stamps - and the editor
 * used to hand Firestore the whole [KinCareReport] under `merge()`, writing all
 * 30 modelled fields back at the value it last loaded. `KinCareReportDiff.kt` says
 * which six of them a draft save owns and why the other 24 are someone else's.
 *
 * THE DRIFT GUARD AT THE BOTTOM IS WHAT KEEPS THAT TRUE. A hand-written field list
 * silently stops saving anything added to the model later, and a field added to
 * the model and to no set at all is a field nobody decided about.
 */
class KinCareReportDiffTest {

    /** The document as it stood when the phone read it, mid-triage and mid-send. */
    private val loaded = KinCareReport(
        id = "rep-1",
        sessionId = "ses-1",
        kinfolkId = "kf-1",
        kinfolkName = "The Alvarez Den",
        authorId = "auntie-1",
        authorDisplayName = "Auntie Rae",
        title = "Biscuit's afternoon",
        bodyCopy = "Biscuit met the neighbour's cat and survived.",
        mediaFileIds = listOf("m-1", "m-2"),
        petMoodSelections = mapOf("kin-1" to "happy"),
        formValues = mapOf("water_bowl" to "topped up"),
        status = ReportStatus.DRAFT.name,
        updatedAt = "2026-01-01T00:00:00Z",
    )

    @Test
    fun `an unchanged report diffs to nothing`() {
        assertEquals(emptyMap<String, Any?>(), kinCareReportFieldChanges(loaded, loaded.copy()))
    }

    @Test
    fun `an edited body is the only thing written`() {
        val edited = loaded.copy(bodyCopy = "Biscuit met the cat and made a friend.")
        val changes = kinCareReportFieldChanges(loaded, edited)
        assertEquals(setOf("bodyCopy"), changes.keys)
        assertEquals(edited.bodyCopy, changes["bodyCopy"])
    }

    /** Clearing the headline is an edit, not a no-op: the blank has to reach the server. */
    @Test
    fun `a title cleared to blank is written as blank`() {
        val changes = kinCareReportFieldChanges(loaded, loaded.copy(title = ""))
        assertEquals(mapOf<String, Any?>("title" to ""), changes)
    }

    /** Same for removing the last photo: the empty list is the operator's decision. */
    @Test
    fun `removing every photo is written as an empty list`() {
        val changes = kinCareReportFieldChanges(loaded, loaded.copy(mediaFileIds = emptyList()))
        assertEquals(mapOf<String, Any?>("mediaFileIds" to emptyList<String>()), changes)
    }

    /**
     * THE OTHER WRITERS' FIELDS NEVER ENTER THE DIFF, even when this client's copy
     * differs. On those fields "differs" means someone else changed it and OUR copy
     * is the stale one - so a plain diff would write `status = DRAFT` back over a
     * `SENT` this client had not yet seen, and blank a triage decision made in
     * KinTale Logs while the draft sat open.
     */
    @Test
    fun `send lifecycle and triage fields are never part of a draft save`() {
        val changes = kinCareReportFieldChanges(
            loaded,
            loaded.copy(
                status = ReportStatus.SENT.name,
                sentAt = "2026-01-02T00:00:00Z",
                sentVia = "catalog",
                deliveryReceiptId = "d-9",
                triageStatus = "assigned",
                triagedAt = "2026-01-02T00:00:00Z",
                triagedBy = "admin-1",
                duplicateOfReportId = "rep-2",
                archiveReason = "bad data",
                kinfolkId = "kf-other",
                kinfolkName = "Someone Else",
            ),
        )
        assertEquals(emptyMap<String, Any?>(), changes)
    }

    /**
     * The stamps and the document identity are the repository's business, never the
     * diff's. Round-tripping the loaded `updatedAt` is the specific way a stamp
     * starts lying about when the KinTale last changed - and once the editor
     * autosaves, the operator reads that stamp as "my work is safe as of then".
     */
    @Test
    fun `stamps and identity never enter the diff`() {
        val changes = kinCareReportFieldChanges(
            loaded,
            loaded.copy(
                id = "other",
                authorId = "someone",
                authorDisplayName = "Someone",
                createdAt = "later",
                updatedAt = "later",
            ),
        )
        assertEquals(emptyMap<String, Any?>(), changes)
    }

    /**
     * Session prefill is write-once at create. `arrivedAt` earns the explicit case:
     * it is `String?` with a `""` default, so a stored null and a freshly scaffolded
     * `""` are unequal, and under the old whole-model write that difference shipped
     * on every single save.
     */
    @Test
    fun `session prefill including the nullable timestamps is never rewritten`() {
        val changes = kinCareReportFieldChanges(
            loaded.copy(arrivedAt = null, departedAt = null),
            loaded.copy(arrivedAt = "", departedAt = "", visitDate = "2026-02-02", templateId = "t-9"),
        )
        assertEquals(emptyMap<String, Any?>(), changes)
    }

    /** A field edited and then put back is not a write; the maps compare by value. */
    @Test
    fun `a body returned to its loaded value is not a change`() {
        val edited = loaded.copy(bodyCopy = "half a sentence")
        assertEquals(setOf("bodyCopy"), kinCareReportFieldChanges(loaded, edited).keys)
        assertEquals(
            emptyMap<String, Any?>(),
            kinCareReportFieldChanges(loaded, edited.copy(bodyCopy = loaded.bodyCopy)),
        )
    }

    // ── Drift guard ──────────────────────────────────────────────────────────

    /**
     * DRIFT GUARD, and the reason this file exists at all.
     *
     * Three failure modes, one test. A field added to [KinCareReport] and to none
     * of the three sets is a field nobody decided about - and on the old code it
     * was written on every save by default, which is how a KinTale editor came to
     * own the triage state. A field added to the differ and not to the model cannot
     * be read. And a field that quietly moves between the sets changes who owns it.
     *
     * The sets must PARTITION the model: every declared field in exactly one.
     */
    @Test
    fun `every model field is owned by exactly one set`() {
        val modelled = KinCareReport::class.java.declaredFields
            .filter { !Modifier.isStatic(it.modifiers) }
            .map { it.name }
            .filterNot { it.startsWith("$") }
            .toSet()

        val claimed = KIN_CARE_REPORT_DIFF_FIELDS.keys + KIN_CARE_REPORT_SERVER_OWNED +
            KIN_CARE_REPORT_OTHER_WRITERS

        assertEquals(
            "KinCareReport gained or lost a field; decide which of the three sets in " +
                "KinCareReportDiff.kt owns it",
            modelled,
            claimed,
        )

        // No field may be claimed twice: overlapping sets would make ownership
        // ambiguous exactly where the fix depends on it being decided.
        val total = KIN_CARE_REPORT_DIFF_FIELDS.size + KIN_CARE_REPORT_SERVER_OWNED.size +
            KIN_CARE_REPORT_OTHER_WRITERS.size
        assertEquals("a field is claimed by more than one set", total, claimed.size)

        // Sanity: the reflection above is reading real fields, not an empty set.
        assertTrue("bodyCopy" in modelled)
        assertTrue("triageStatus" in modelled)
    }
}
