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
            "Held back \"KinCare Auntie on my way\": notices to households are turned off",
            activityEntryDescription(heldAsStored),
        )
        assertEquals("Not sent", activityStatusWords(heldAsStored))
        assertEquals("NOT_SENT", activityEffectiveStatus(heldAsStored))
    }

    @Test
    fun `it prints no stored key with a title that contradicts it, and no id in the sentence`() {
        val sentence = activityEntryDescription(heldAsStored)
        assertFalse(sentence.contains("uid="))
        assertFalse(sentence.contains("AbCdEf"))
        assertFalse(sentence.contains("household_notices_off"))
    }

    @Test
    fun `the row and the opened entry carry the words, and the status is never SUCCESS`() {
        assertEquals(
            "Held back \"KinCare Auntie on my way\": notices to households are turned off",
            rowContext(heldAsStored),
        )
        val rows = activityDetailRows(heldAsStored)
        assertTrue(rows.contains("Status" to "Not sent"))
        assertFalse(rows.contains("Status" to "SUCCESS"))
        assertTrue(rows.contains("Detail" to "Held back \"KinCare Auntie on my way\": notices to households are turned off"))
        // #1818: the stored key is not on screen; it stays on the sealed entry.
        assertFalse(rows.any { it.second == "NOTIFICATION_DISPATCHED" || it.first == "Action" })
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
            "Did not send \"KinCare Auntie arrived\": this notification is turned off in Settings",
            noticeNotSentWords("kincare.auntie.arrived", "household_prefs_suppressed"),
        )
        assertEquals(
            "Did not send \"KinCare Auntie arrived\": nobody in the household has a MyTribe sign-in",
            noticeNotSentWords("kincare.auntie.arrived", "household_has_no_portal_account"),
        )
        assertEquals(
            "Did not send \"KinCare Auntie arrived\": there was nobody to send it to",
            noticeNotSentWords("kincare.auntie.arrived", "no_recipient"),
        )
        assertEquals("Did not send \"KinCare Auntie arrived\"", noticeNotSentWords("kincare.auntie.arrived", "some_new_reason"))
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
            // #2341, #2340: a run's turned-off copies, and a marketing blast's held ones.
            "Did not send 14 invoice reminders: this notification is turned off in Settings",
            "Did not send 1 overdue invoice notice: this notification is turned off in Settings",
            "Held back 180 notices from a marketing blast: notices to households are turned off",
            "Did not send 180 notices from a marketing blast: this notification is turned off in Settings",
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
        assertEquals("Failed", activityStatusWords(failed))
        assertEquals(rowTone("LOGIN", "FAILURE"), rowTone(failed.actionType, activityEffectiveStatus(failed)))
    }

    @Test
    fun `a notice that did go out is untouched`() {
        assertFalse(isNoticeNotSent(sent))
        assertEquals("Notification dispatched", activityEntryTitle(sent))
        assertEquals("Sending \"Your Auntie is on the way\" to Dre East by email", activityEntryDescription(sent))
        assertEquals("Done", activityStatusWords(sent))
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
    fun `no row ends in a database path, and neither does the opened entry`() {
        // #1905, #1818: the walk read "notifications/<id>" and "kin_care_sessions/<id>".
        assertEquals("Sending \"Your Auntie is on the way\" to Dre East by email", rowContext(sent))
        val visit = ActivityLogEntry(actionType = "VISIT_ARRIVED", targetId = "s1", targetCollection = "kin_care_sessions")
        assertEquals("", rowContext(visit))
        assertFalse(activityDetailRows(sent).any { it.first == "Target" })
    }
}
