package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.admin.ActivityLogEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * #1818, #1881: the Activity Log says what happened in words. No stored key,
 * no uid, no database path, brand words in their casing. Same cases as the web
 * (`lib/activityDetail.test.ts`) and the desktop console.
 */
class ActivityPlainWordsTest {

    @Test
    fun aLineStoredAsItsKeyAndTheActorsUidReadsAsItsTitleAlone() {
        val stored = ActivityLogEntry(
            id = "e1",
            actionType = "CREATE_KINCARE_SESSION",
            description = "CREATE_KINCARE_SESSION uid=Abc123Def456Ghi789Jkl012Mno3",
            actorId = "Abc123Def456Ghi789Jkl012Mno3",
            actorRole = "AUNTIE",
        )
        assertEquals("Create KinCare session", activityEntryTitle(stored))
        assertEquals("", activityEntryDescription(stored))
        assertEquals("Staff", rowContext(stored))
        assertEquals("", activityDescriptionWords("BILLING_INVOICE_PAID"))
        assertEquals("", activityDescriptionWords("CONTENT_SHARE_LINK_EXPIRED"))
        assertEquals("", activityDescriptionWords("ADMIN_IMPERSONATION (client-actor=other-user)"))
    }

    @Test
    fun theRowNamesTheActorByNameOrRoleAndNeverByUidOrEmail() {
        val tap = ActivityLogEntry(
            id = "e2",
            actionType = "VISIT_ON_MY_WAY",
            description = "Marked the visit on the way: scheduled to on the way",
            actorId = "u1",
            actorRole = "AUNTIE",
            targetCollection = "kin_care_sessions",
            targetId = "vis_ABCDEFGHIJ0123456789",
        )
        val words = "Marked the visit on the way: scheduled to on the way"
        assertEquals("$words · Syd East", rowContext(tap, mapOf("u1" to "Syd East")))
        assertEquals("$words · Operator", rowContext(tap, roles = mapOf("u1" to "owner")))
        assertEquals("$words · Staff", rowContext(tap, mapOf("u1" to "e2e-admin@tribetails.com")))
        assertFalse(rowContext(tap).contains("kin_care_sessions"))
        assertFalse(rowContext(tap).contains("u1"))
    }

    @Test
    fun aSentenceThatOnlyRepeatsTheTitleIsLeftOff() {
        val line = ActivityLogEntry(id = "e3", actionType = "UPDATE_KINFOLK", description = "Kinfolk updated")
        assertEquals("Kinfolk updated", activityEntryTitle(line))
        assertEquals("", rowContext(line))
    }

    @Test
    fun aStoredVisitRequestReadsInWords() {
        assertEquals(
            "Kinfolk asked for 1 visit (individual dates)",
            activityDescriptionWords("Kinfolk submitted 1 visit(s) (individual)"),
        )
    }

    @Test
    fun brandWordsKeepTheirCasing() {
        assertEquals("KinTale sent", activityTitle("CONTENT_KINTALE_SENT"))
        assertEquals("Visit: on my way", activityTitle("VISIT_ON_MY_WAY"))
        assertEquals("KinTale draft published", activityTitle("KINTALE_DRAFT_PUBLISHED"))
        assertEquals("AI tale titles applied", activityTitle("AI_TALE_TITLES_APPLIED"))
        assertEquals(
            "Sent \"KinCare booking confirm\" by email",
            activityDescriptionWords("Notification kincare.booking.confirm dispatched to email"),
        )
    }
}
