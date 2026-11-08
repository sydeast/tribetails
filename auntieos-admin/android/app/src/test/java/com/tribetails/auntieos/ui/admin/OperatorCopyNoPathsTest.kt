package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.ui.communicate.draftCalloutSubtitle
import com.tribetails.auntieos.ui.members.INVITES_PANEL_TIP
import com.tribetails.auntieos.ui.members.PRIMARY_PANEL_TIP
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * #1592: Feature Flags and Template Routing printed database paths
 * (`business_settings/feature_flags`, `emailTemplates/<id>`) and a function name
 * (`listCatalogKeys`) as standing copy. None of it is the operator's to read.
 */
class OperatorCopyNoPathsTest {

    private val developerMarks = listOf("business_settings", "auntieos.", "Templates/", "listCatalogKeys", ".ts")

    private fun assertOperatorCopy(text: String) {
        developerMarks.forEach { mark -> assertFalse("\"$text\" carries \"$mark\"", text.contains(mark)) }
    }

    @Test fun featureFlagsHeadingNamesNoPathOrPrefix() {
        assertOperatorCopy(FEATURE_FLAGS_SUBTITLE)
    }

    @Test fun templateRoutingCopyNamesNoPathOrFunction() {
        assertOperatorCopy(TEMPLATE_MISSING_LINE)
        assertOperatorCopy(ROUTING_TABLE_EMPTY)
        assertOperatorCopy(overrideDialogHint())
    }

    private val machineryMarks = listOf("Firestore", "Timestamp", "audit writer", "SendGrid", "dumb pipe", "server reads", "nightly sweep")
    private fun assertNoMachinery(text: String) {
        machineryMarks.forEach { mark -> assertFalse("\"$text\" carries \"$mark\"", text.contains(mark)) }
    }
    @Test fun templateBankPreviewHintNamesNoStoreOrVendor() {
        assertNoMachinery(TEMPLATE_PREVIEW_HINT)
    }
    @Test fun activityLogTimeWarningIsTheOperatorsSentence() {
        val note = unreadableTimesNote(2, 40)
        assertNoMachinery(note)
        assertFalse(note.contains("ISO-8601"))
        assertEquals(
            "2 of 40 entries have a time this screen cannot read, so their day and order below are a best guess.",
            note,
        )
    }
    @Test fun householdMembersTipsSayNothingAboutTheServer() {
        assertNoMachinery(PRIMARY_PANEL_TIP)
        assertNoMachinery(INVITES_PANEL_TIP)
    }
    @Test fun draftLineNamesWhoAndWhatNeverTheModelOrDraftId() {
        assertEquals("for Dana Reyes · KinTale", draftCalloutSubtitle("Dana Reyes", "visit_report"))
        assertEquals("Blog", draftCalloutSubtitle("", "blog_post"))
        assertEquals("for Dana Reyes", draftCalloutSubtitle("Dana Reyes", " "))
    }
}
