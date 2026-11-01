package com.kinfolk.portal.share

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1331 and #1332. The request shapes every ShareLinkFetcher actual (js and
 * jvm) builds through commonMain, so the js actual, which has no test source
 * set of its own, is covered here.
 */
class ShareLinkRequestTest {
    private val base = "https://example.test"

    @Test
    fun noPasscodeIsAPlainGetWithNoQuery() {
        val r = shareLinkRequest(base, "s1", null)
        assertEquals("GET", r.method)
        assertEquals("$base/getShareLink/s1", r.url)
        assertNull(r.body)
        assertEquals(r, shareLinkRequest(base, "s1", "  "))
    }

    @Test
    fun aPasscodeGoesInThePostBodyNeverTheUrl() {
        val r = shareLinkRequest(base, "s1", "1234")
        assertEquals("POST", r.method)
        assertEquals("$base/getShareLink/s1", r.url)
        assertFalse(r.url.contains("?"))
        assertFalse(r.url.contains("1234"))
        assertEquals("1234", r.body!!["passcode"]!!.jsonPrimitive.content)
    }

    @Test
    fun okReplySplitsTheUnlockTokenFromThePayload() {
        val reply = buildJsonObject {
            put("body", "Biscuit napped.")
            put("sourceKinTaleId", "tale-1")
            put("unlockToken", "v1.1.sig")
        }
        val ok = shareLinkOk(reply)
        assertEquals("v1.1.sig", ok.unlockToken)
        assertFalse(ok.payload.containsKey("unlockToken"))
        assertEquals(JsonPrimitive("tale-1"), ok.payload["sourceKinTaleId"])
        assertNull(shareLinkOk(buildJsonObject { put("body", "x") }).unlockToken)
    }

    @Test
    fun guestCommentBodyCarriesTheUnlockTokenOnlyWhenPresent() {
        val withToken = guestCommentBody("s1", "tale-1", "hi", "Ann", "catch@hanasamku.com", "cap", null, "v1.1.sig")
        assertEquals("v1.1.sig", withToken["unlockToken"]!!.jsonPrimitive.content)
        assertFalse(withToken.containsKey("passcode"))
        assertFalse(withToken.containsKey("parentCommentId"))
        val open = guestCommentBody("s1", "tale-1", "hi", "Ann", "catch@hanasamku.com", "cap", "p1", null)
        assertFalse(open.containsKey("unlockToken"))
        assertEquals("p1", open["parentCommentId"]!!.jsonPrimitive.content)
    }

    @Test
    fun aRefusedNoteFor401SaysToUnlockAgain() {
        val e = assertFailsWith<ShareFetchException> { guestCommentResult(401) { JsonObject(emptyMap()) } }
        assertEquals(GUEST_NOTE_LOCKED_MESSAGE, e.message)
        assertEquals("c1", guestCommentResult(200) { buildJsonObject { put("commentId", "c1") } })
        assertTrue(
            assertFailsWith<ShareFetchException> { guestCommentResult(429) { JsonObject(emptyMap()) } }
                .message!!.contains("Too many"),
        )
    }
}
