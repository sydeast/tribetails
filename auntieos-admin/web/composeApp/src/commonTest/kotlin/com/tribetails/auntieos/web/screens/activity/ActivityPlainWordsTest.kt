package com.tribetails.auntieos.web.screens.activity

import com.tribetails.auntieos.web.data.ActivityLogEntry
import com.tribetails.auntieos.web.data.activityDescriptionWords
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #1818, #1881: the Activity Log says what happened in words. No stored key,
 * no uid, no database path, brand words in their casing. Same cases as the web
 * (`lib/activityDetail.test.ts`) and Android.
 */
class ActivityPlainWordsTest {

    @Test
    fun aLineStoredAsItsKeyAndTheActorsUidReadsAsItsTitleAlone() {
        val stored = ActivityLogEntry(
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
    fun theOpenedEntryShowsNoKeyIdOrPathAndNamesTheHousehold() {
        val entry = ActivityLogEntry(
            timestamp = "2026-11-11T17:33:35.411Z",
            actionType = "CANCEL_BOOKING_SERIES",
            status = "SUCCESS",
            actorId = "u1",
            familyId = "fam1",
            targetCollection = "kin_care_sessions",
            targetId = "vis_1",
        )
        val rows = activityDetailRows(
            entry,
            households = mapOf("fam1" to "The Whitfields"),
            names = mapOf("u1" to "Syd East"),
        )
        assertEquals("When" to "Nov 11, 2026 11:33", rows.first())
        assertTrue(rows.contains("Status" to "Done"))
        assertTrue(rows.contains("Household" to "The Whitfields"))
        assertTrue(rows.contains("Actor" to "Syd East"))
        for (label in listOf("Action", "Actor id", "Target", "Business time")) {
            assertFalse(rows.any { it.first == label }, label)
        }
        assertFalse(rows.any { it.second.contains("CANCEL_BOOKING_SERIES") || it.second.contains("fam1") })
    }

    @Test
    fun aSentenceThatOnlyRepeatsTheTitleIsLeftOff() {
        val line = ActivityLogEntry(actionType = "UPDATE_KINFOLK", description = "Kinfolk updated")
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
        assertEquals("KinCare arrived", activityTitle("KINCARE_ARRIVED"))
        assertEquals("KinTale draft published", activityTitle("KINTALE_DRAFT_PUBLISHED"))
        assertEquals(
            "Sent \"KinCare booking confirm\" by email",
            activityDescriptionWords("Notification kincare.booking.confirm dispatched to email"),
        )
    }

    /** #1880: the list draws the newest 500, and each press draws 200 more, until none are left. */
    @Test
    fun loadOlderEntriesReachesEveryEntry() {
        assertEquals(500, renderedEntryCount(1059, 0))
        assertEquals(700, renderedEntryCount(1059, 1))
        assertEquals(1059, renderedEntryCount(1059, 3))
        assertEquals(12, renderedEntryCount(12, 0))
    }
}
