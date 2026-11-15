package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.admin.ActivityLogEntry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1819, #1905: A NOTICE THAT DID NOT GO OUT, AS THE ACTIVITY LOG READS IT.
 *
 * The walk's row, as it was stored: "Notification dispatched", status SUCCESS,
 * description `NOTIFICATION_DISPATCHED uid=<28 characters>`, and the truth only
 * in the opened payload as stored keys. Stored rows are evidence and are never
 * rewritten, so these pin what the row SAYS about one. Same cases as the web
 * (`lib/activityNotice.test.ts`) and the desktop console.
 */
class ActivityNoticeTest {

    /** The row #1819 found, after the "OMW" tap with household notices off. */
    private val heldAsStored = ActivityLogEntry(
        id = "held1",
        timestamp = "2026-11-10T23:14:00.000Z",
        actionType = "NOTIFICATION_DISPATCHED",
        description = "NOTIFICATION_DISPATCHED uid=AbCdEfGhIjKlMnOpQrStUvWxYz12",
        status = "SUCCESS",
        payload = mapOf(
            "key" to "kincare.auntie.on_my_way",
            "event" to "on_my_way",
            "dispatchIds" to emptyList<String>(),
            "reason" to "household_notices_off",
        ),
    )

    /** What the server writes now. */
    private val heldNow = ActivityLogEntry(
        id = "held2",
        actionType = "NOTIFICATION_NOT_SENT",
        description = "Held back \"Your Auntie is on the way\" for Dre East: notices to households are turned off",
        status = "NOT_SENT",
        payload = mapOf("key" to "kincare.auntie.on_my_way", "outcome" to "held"),
    )

    private val sent = ActivityLogEntry(
        id = "sent1",
        actionType = "NOTIFICATION_DISPATCHED",
        description = "Sending \"Your Auntie is on the way\" to Dre East by email",
        status = "SUCCESS",
        targetId = "n1",
        targetCollection = "notifications",
        payload = mapOf("key" to "kincare.auntie.on_my_way", "channels" to listOf("email")),
    )

    @Test
    fun `a held notice stored as dispatched reads as not sent`() {
        assertTrue(isNoticeNotSent(heldAsStored))
        assertEquals("Notification not sent", activityEntryTitle(heldAsStored))
        assertEquals(
            "Held back \"Kincare auntie on my way\": notices to households are turned off",
            activityEntryDescription(heldAsStored),
        )
        assertEquals("Not sent", activityStatusWords(heldAsStored))
        assertEquals("NOT_SENT", activityEffectiveStatus(heldAsStored))
    }

    @Test
    fun `it prints no stored key with a title that contradicts it, and no id in the sentence`() {
        assertFalse(activityEntryShowsCode(heldAsStored))
        val sentence = activityEntryDescription(heldAsStored)
        assertFalse(sentence.contains("uid="))
        assertFalse(sentence.contains("AbCdEf"))
        assertFalse(sentence.contains("household_notices_off"))
    }

    @Test
    fun `the row and the opened entry carry the words, and the status is never SUCCESS`() {
        assertEquals(
            "Held back \"Kincare auntie on my way\": notices to households are turned off",
            rowContext(heldAsStored),
        )
        val rows = activityDetailRows(heldAsStored)
        assertTrue(rows.contains("Status" to "Not sent"))
        assertFalse(rows.contains("Status" to "SUCCESS"))
        assertTrue(rows.contains("Detail" to "Held back \"Kincare auntie on my way\": notices to households are turned off"))
        // The stored key stays on the opened record: it is the evidence.
        assertTrue(rows.contains("Action" to "NOTIFICATION_DISPATCHED"))
    }

    @Test
    fun `it is found by the words the row shows`() {
        assertTrue(matchesQuery(heldAsStored, "not sent"))
        assertTrue(matchesQuery(heldAsStored, "held back"))
        assertTrue(matchesQuery(heldAsStored, "turned off"))
    }

    @Test
    fun `each stored reason has its words, and an unknown one is not printed as a key`() {
        assertEquals(
            "Did not send \"Kincare auntie arrived\": this notification is turned off in Settings",
            noticeNotSentWords("kincare.auntie.arrived", "household_prefs_suppressed"),
        )
        assertEquals(
            "Did not send \"Kincare auntie arrived\": nobody in the household has a MyTribe sign-in",
            noticeNotSentWords("kincare.auntie.arrived", "household_has_no_portal_account"),
        )
        assertEquals(
            "Did not send \"Kincare auntie arrived\": there was nobody to send it to",
            noticeNotSentWords("kincare.auntie.arrived", "no_recipient"),
        )
        assertEquals("Did not send \"Kincare auntie arrived\"", noticeNotSentWords("kincare.auntie.arrived", "some_new_reason"))
        assertEquals(
            "Held back a notification: notices to households are turned off",
            noticeNotSentWords("", "household_notices_off"),
        )
    }

    @Test
    fun `the line the server writes now shows its sentence as written`() {
        assertTrue(isNoticeNotSent(heldNow))
        assertEquals("Notification not sent", activityEntryTitle(heldNow))
        assertEquals(
            "Held back \"Your Auntie is on the way\" for Dre East: notices to households are turned off",
            activityEntryDescription(heldNow),
        )
        assertEquals("Not sent", activityStatusWords(heldNow))
    }

    /** #2331: the summary line needs no client code; this pins that it passes through untouched. */
    @Test
    fun `the one line a timed job writes for a run reads as the server wrote it`() {
        val summary = heldNow.copy(
            description = "Held back 14 visit reminders: notices to households are turned off",
            payload = mapOf("outcome" to "held", "summary" to true, "count" to 14),
        )
        assertTrue(isNoticeNotSent(summary))
        assertEquals("Notification not sent", activityEntryTitle(summary))
        assertEquals("Held back 14 visit reminders: notices to households are turned off", activityEntryDescription(summary))
        assertEquals("Not sent", activityStatusWords(summary))
        for (words in listOf(
            "Held back 1 invoice reminder: notices to households are turned off",
            "Held back 2 overdue invoice notices: notices to households are turned off",
            "Held back 3 visit reminders: the setting for notices to households could not be read",
        )) {
            assertEquals(words, activityEntryDescription(summary.copy(description = words)))
        }
    }
    @Test
    fun `a send that failed keeps its own status and the error tone`() {
        val failed = heldNow.copy(
            status = "FAILURE",
            description = "Could not send \"Invoice sent\" to Dre East by email: the send failed",
        )
        assertEquals("FAILURE", activityStatusWords(failed))
        assertEquals(rowTone("LOGIN", "FAILURE"), rowTone(failed.actionType, activityEffectiveStatus(failed)))
    }

    @Test
    fun `a notice that did go out is untouched`() {
        assertFalse(isNoticeNotSent(sent))
        assertEquals("Notification dispatched", activityEntryTitle(sent))
        assertTrue(activityEntryShowsCode(sent))
        assertEquals("Sending \"Your Auntie is on the way\" to Dre East by email", activityEntryDescription(sent))
        assertEquals("SUCCESS", activityStatusWords(sent))
    }

    @Test
    fun `a dispatched row with ids, with no reason, or of another kind is never read as held`() {
        fun dispatched(payload: Map<String, Any?>, actionType: String = "NOTIFICATION_DISPATCHED") =
            ActivityLogEntry(actionType = actionType, status = "SUCCESS", payload = payload)
        assertFalse(isNoticeNotSent(dispatched(mapOf("dispatchIds" to listOf("n1"), "reason" to null))))
        assertFalse(isNoticeNotSent(dispatched(mapOf("dispatchIds" to listOf("n1"), "reason" to "x"))))
        assertFalse(isNoticeNotSent(dispatched(mapOf("dispatchIds" to emptyList<String>(), "reason" to ""))))
        assertFalse(isNoticeNotSent(dispatched(mapOf("reason" to "household_notices_off"))))
        assertFalse(isNoticeNotSent(dispatched(mapOf("dispatchIds" to "none", "reason" to 7))))
        assertFalse(isNoticeNotSent(dispatched(emptyMap())))
        assertFalse(
            isNoticeNotSent(
                dispatched(mapOf("dispatchIds" to emptyList<String>(), "reason" to "household_notices_off"), "VISIT_ARRIVED"),
            ),
        )
    }

    @Test
    fun `a notification row does not end in a database path, and other rows keep their target`() {
        // #1905: the walk read "notifications/<id>" at the end of each row.
        assertEquals("Sending \"Your Auntie is on the way\" to Dre East by email", rowContext(sent))
        for (kind in listOf("NOTIFICATION_DISPATCHED", "NOTIFICATION_RECEIVED", "NOTIFICATION_NOT_SENT", "NOTIFICATION_VIEWED")) {
            assertFalse(activityRowShowsTarget(ActivityLogEntry(actionType = kind)))
        }
        val visit = ActivityLogEntry(actionType = "VISIT_ARRIVED", targetId = "s1", targetCollection = "kin_care_sessions")
        assertTrue(activityRowShowsTarget(visit))
        assertEquals("kin_care_sessions/s1", rowContext(visit))
        // The opened entry still carries the target.
        assertTrue(activityDetailRows(sent).contains("Target" to "notifications/n1"))
    }
}
