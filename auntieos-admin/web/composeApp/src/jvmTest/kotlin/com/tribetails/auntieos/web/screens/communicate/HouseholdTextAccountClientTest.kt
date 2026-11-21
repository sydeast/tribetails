package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #2316 (operator ruling 2026-11-20): the console's Text confirm asks the
 * server whether the household has a MyTribe account, with the question the
 * send itself answers (`resolveKinfolkUid`), not from the roster.
 */
class HouseholdTextAccountClientTest {
    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    @Test
    fun noPortalAccountIsTheWholeMessage() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "previewVisitNotification" to """{"ok":true,"willNotify":false,"reason":"household_has_no_portal_account"}""",
        )
        assertEquals(WriteResult.Ok(HouseholdTextAccount.NoAccount), FirestoreClient().previewHouseholdTextAccount("kf1"))
        // Asked with the household alone: no key, so the server answers the account question.
        val body = Json.parseToJsonElement(JvmFirestoreFixtures.lastCallablePayloadJson!!).jsonObject
        assertEquals("kf1", body["familyId"]!!.jsonPrimitive.content)
        assertNull(body["key"])
    }

    @Test
    fun anAccountWithNoticesOffIsStillAnAccount() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "previewVisitNotification" to """{"ok":true,"willNotify":false,"reason":"household_notices_off"}""",
        )
        assertEquals(WriteResult.Ok(HouseholdTextAccount.Account), FirestoreClient().previewHouseholdTextAccount("kf1"))
        JvmFirestoreFixtures.callableResponses = mapOf("previewVisitNotification" to """{"ok":true,"willNotify":true,"reason":null}""")
        assertEquals(WriteResult.Ok(HouseholdTextAccount.Account), FirestoreClient().previewHouseholdTextAccount("kf1"))
    }

    @Test
    fun errorAFailedCallIsNoAnswer() = runBlocking {
        JvmFirestoreFixtures.callableErrors = mapOf("previewVisitNotification" to "unavailable")
        assertTrue(FirestoreClient().previewHouseholdTextAccount("kf1") is WriteResult.Err)
    }

    @Test
    fun negativeAnAnswerWithNoVerdictIsNoAnswer() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("previewVisitNotification" to """{"ok":true}""")
        assertTrue(FirestoreClient().previewHouseholdTextAccount("kf1") is WriteResult.Err)
    }

    @Test
    fun negativeNoHouseholdAsksNothing() = runBlocking {
        assertTrue(FirestoreClient().previewHouseholdTextAccount(" ") is WriteResult.Err)
        assertNull(JvmFirestoreFixtures.lastCallableName)
    }
}
