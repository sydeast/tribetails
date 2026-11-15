package com.tribetails.auntieos.web.screens.activity

import com.tribetails.auntieos.web.data.ActivityLogEntry
import com.tribetails.auntieos.web.data.noticeNotSentWords
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #1819, #1905: A NOTICE THAT DID NOT GO OUT, AS THE ACTIVITY LOG READS IT.
 *
 * The walk's row, as it was stored: "Notification dispatched", status SUCCESS,
 * description `NOTIFICATION_DISPATCHED uid=<28 characters>`, and the truth only
 * in the opened payload as stored keys. Stored rows are evidence and are never
 * rewritten, so these pin what the row SAYS about one. Same cases as the web
 * (`lib/activityNotice.test.ts`) and Android.
 */
class ActivityNoticeTest {

    /** The row #1819 found, after the "OMW" tap with household notices off. */
    private val heldAsStored = ActivityLogEntry(
        timestamp = "2026-11-10T23:14:00.000Z",
        actionType = "NOTIFICATION_DISPATCHED",
        description = "NOTIFICATION_DISPATCHED uid=AbCdEfGhIjKlMnOpQrStUvWxYz12",
        status = "SUCCESS",
        payload = buildJsonObject {
            put("key", "kincare.auntie.on_my_way")
            put("event", "on_my_way")
            put("dispatchIds", buildJsonArray { })
            put("reason", "household_notices_off")
        },
    )

    /** What the server writes now. */
    private val heldNow = ActivityLogEntry(
        actionType = "NOTIFICATION_NOT_SENT",
        description = "Held back \"Your Auntie is on the way\" for Dre East: notices to households are turned off",
        status = "NOT_SENT",
        payload = buildJsonObject {
            put("key", "kincare.auntie.on_my_way")
            put("outcome", "held")
        },
    )

    private val sent = ActivityLogEntry(
        actionType = "NOTIFICATION_DISPATCHED",
        description = "Sending \"Your Auntie is on the way\" to Dre East by email",
        status = "SUCCESS",
        targetId = "n1",
        targetCollection = "notifications",
        payload = buildJsonObject {
            put("key", "kincare.auntie.on_my_way")
            put("channels", buildJsonArray { add(JsonPrimitive("email")) })
        },
    )

    @Test
    fun `a held notice stored as dispatched reads as not sent`() {
        assertTrue(isNoticeNotSent(heldAsStored))
        assertEquals("Notification not sent", activityEntryTitle(heldAsStored))
        assertEquals(
            "Held back \"Kincare auntie on my way\": notices to households are turned off",
            activityEntryDescription(heldAsStored),
        )
        // The row's pill and the opened entry: "Not sent", never SUCCESS.
        assertEquals("Not sent", activityStatusWords(heldAsStored))
        assertEquals("NOT_SENT", activityEffectiveStatus(heldAsStored))
    }

    @Test
    fun `it prints no stored key beside a title that contradicts it, and no id in the sentence`() {
        assertFalse(activityEntryShowsCode(heldAsStored))
        val sentence = activityEntryDescription(heldAsStored)
        assertFalse(sentence.contains("uid="))
        assertFalse(sentence.contains("AbCdEf"))
        assertFalse(sentence.contains("household_notices_off"))
    }

    @Test
    fun `the row carries the words and is found by them`() {
        assertEquals(
            "Held back \"Kincare auntie on my way\": notices to households are turned off",
            rowContext(heldAsStored),
        )
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
        fun ids(vararg id: String) = buildJsonArray { id.forEach { add(JsonPrimitive(it)) } }
        fun dispatched(actionType: String = "NOTIFICATION_DISPATCHED", build: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit) =
            ActivityLogEntry(actionType = actionType, status = "SUCCESS", payload = buildJsonObject(build))
        assertFalse(isNoticeNotSent(dispatched { put("dispatchIds", ids("n1")); put("reason", JsonNull) }))
        assertFalse(isNoticeNotSent(dispatched { put("dispatchIds", ids("n1")); put("reason", "x") }))
        assertFalse(isNoticeNotSent(dispatched { put("dispatchIds", ids()); put("reason", "") }))
        assertFalse(isNoticeNotSent(dispatched { put("reason", "household_notices_off") }))
        assertFalse(isNoticeNotSent(dispatched { put("dispatchIds", "none"); put("reason", "household_notices_off") }))
        assertFalse(isNoticeNotSent(ActivityLogEntry(actionType = "NOTIFICATION_DISPATCHED")))
        assertFalse(isNoticeNotSent(ActivityLogEntry(actionType = "NOTIFICATION_DISPATCHED", payload = JsonPrimitive("oops"))))
        assertFalse(
            isNoticeNotSent(dispatched("VISIT_ARRIVED") { put("dispatchIds", ids()); put("reason", "household_notices_off") }),
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
    }
}
