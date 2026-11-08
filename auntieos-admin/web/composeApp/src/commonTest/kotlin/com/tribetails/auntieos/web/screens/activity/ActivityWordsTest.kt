package com.tribetails.auntieos.web.screens.activity

import com.tribetails.auntieos.web.data.ActivityLogEntry
import com.tribetails.auntieos.web.data.ActivityWords
import com.tribetails.auntieos.web.data.activityDescriptionWords
import com.tribetails.auntieos.web.screens.admin.templateSavedNotice
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * #1747: the stored Activity Log rows that name `generated_drafts/<id>` read as
 * words, the web `activityWords.test.ts` cases. The Template Bank's save notice
 * never falls back to the template id.
 */
class ActivityWordsTest {
    @Test
    fun aStoredCommunicateApprovalReadsAsWords() {
        assertEquals(ActivityWords.DRAFT_APPROVED, activityDescriptionWords("Approved generated_drafts/aB3dE9 (kf-robyn)"))
        assertEquals(ActivityWords.DRAFT_APPROVED, activityDescriptionWords("Approved generated_drafts/aB3dE9 (no-kinfolk)"))
    }

    @Test
    fun theStoredKinTaleDraftSendAndDeleteReadAsWords() {
        assertEquals(
            "Sent a KinTale draft",
            activityDescriptionWords("Sent draft generated_drafts/d1 as KinTale rep_77 (kf-robyn)"),
        )
        assertEquals("Deleted a KinTale draft", activityDescriptionWords("Deleted draft generated_drafts/d1 (no household)"))
        assertEquals(
            "Deleted a KinTale draft",
            activityDescriptionWords("Deleted unsent KinTale draft kin_care_reports/r1 (kf-robyn)"),
        )
    }

    @Test
    fun noDraftPathSurvivesAndPlainTextPassesThrough() {
        assertEquals("Restored a draft by hand", activityDescriptionWords("Restored generated_drafts/d1 by hand"))
        assertEquals("signed in", activityDescriptionWords(" signed in "))
    }

    @Test
    fun theRowShowsTheWordsAndTheStoredEntryIsUntouched() {
        val stored = ActivityLogEntry(actionType = "DRAFT_APPROVED", description = "Approved generated_drafts/aB3dE9 (kf-robyn)")
        assertEquals("Approved an Auntie AI draft", rowContext(stored))
        assertEquals("Approved generated_drafts/aB3dE9 (kf-robyn)", stored.description)
    }

    @Test
    fun theTemplateBankNoticeNamesTheTemplateNeverItsId() {
        assertEquals("Saved Booking Confirmed.", templateSavedNotice("Booking Confirmed"))
        assertEquals("Saved the untitled template.", templateSavedNotice("  "))
    }
}
