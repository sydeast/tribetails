package com.kinfolk.portal.portal

import com.kinfolk.portal.firebase.FunctionsClient
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * #1504: the warm call itself. Which client it goes through, what it sends,
 * and that a failure stays a value instead of an exception.
 */
class WarmSaveTest {

    /** The session-reacting client: a warm call must never reach it. */
    private class ReactingClient(val quiet: FunctionsClient) : FunctionsClient {
        override suspend fun call(name: String, payload: JsonObject?): JsonObject =
            fail("warm call went through the session-reacting client: $name")
        override fun withoutSessionReaction(): FunctionsClient = quiet
    }

    private class RecordingClient(val answer: suspend (String) -> JsonObject) : FunctionsClient {
        val calls = mutableListOf<Pair<String, JsonObject?>>()
        override suspend fun call(name: String, payload: JsonObject?): JsonObject {
            calls += name to payload
            return answer(name)
        }
    }

    @Test
    fun sendsExactlyTheWarmMarker_throughTheClientWithoutSessionReaction() = runTest {
        val quiet = RecordingClient { buildJsonObject { put("ok", true); put("warm", true) } }
        val result = warmSave(ReactingClient(quiet), WarmableSave.SaveMyAccount, log = { fail("logged on success: $it") })
        assertTrue(result.isSuccess)
        assertEquals(listOf<Pair<String, JsonObject?>>("saveMyAccount" to buildJsonObject { put("__warm", true) }), quiet.calls)
    }

    @Test
    fun theMarkerIsTheWholePayload() {
        assertEquals("""{"__warm":true}""", WARM_PAYLOAD.toString())
        assertTrue(isWarmPayload(buildJsonObject { put("__warm", true) }))
        assertTrue(!isWarmPayload(buildJsonObject { put("__warm", true); put("displayName", "Ana") }))
        assertTrue(!isWarmPayload(null))
    }

    @Test
    fun aFailedWarmCall_isAFailureValue_loggedOnce_neverThrown() = runTest {
        val quiet = RecordingClient { throw IllegalStateException("UNAVAILABLE: cold") }
        val logged = mutableListOf<String>()
        val result = warmSave(ReactingClient(quiet), WarmableSave.RequestBooking, log = { logged += it })
        assertTrue(result.isFailure)
        assertEquals(1, logged.size)
        assertTrue(logged.single().startsWith("requestBooking warm call failed"), logged.single())
    }

    @Test
    fun cancellationStillCancels() = runTest {
        val quiet = RecordingClient { throw CancellationException("screen closed") }
        assertFailsWith<CancellationException> {
            warmSave(ReactingClient(quiet), WarmableSave.AddKin, log = {})
        }
    }

    /**
     * The web's `lib/warmSave.ts` keeps the same list; its test reads this
     * file and fails when the two drift.
     */
    @Test
    fun warmsTheSavesIssue1504Names_andNothingElse() {
        assertEquals(
            listOf(
                "saveMyAccount", "saveTribeProfile", "saveHomeAccess", "saveMyNotificationPrefs",
                "addBookingNote", "requestBooking", "addKin", "updateKin", "createShareLink",
                "generate", "sendKinfolkMessage",
            ),
            WarmableSave.entries.map { it.callable },
        )
    }
}
