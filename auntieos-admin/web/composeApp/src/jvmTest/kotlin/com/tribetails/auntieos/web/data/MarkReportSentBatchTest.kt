package com.tribetails.auntieos.web.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #2123: the console's KinTale send is ONE Firestore `:commit`, and its session
 * write now also clears `kinTaleDue`, the stamp the server puts on a visit
 * completed while "KinTale required" is on. That is what takes the Auntie's
 * "Send the KinTale" task away. The send asks nothing of `transitionBookingStatus`:
 * the visit was completed when the Auntie left.
 */
class MarkReportSentBatchTest {

    private val fs = MaskApplyingFirestore()

    @AfterTest
    fun tearDown() = fs.stop()

    private fun send(): JsonObject {
        fs.start()
        val r = runBlocking { platformMarkKinTaleReportSent("r1", "s1", "pending", "", "2026-11-12T18:00:00Z") }
        assertEquals(WriteResult.Ok(Unit), r)
        val (path, body) = fs.posts.single()
        assertEquals("documents:commit", path)
        return Json.parseToJsonElement(body).jsonObject
    }

    private fun sessionWrite(commit: JsonObject): JsonObject =
        commit["writes"]!!.jsonArray.map { it.jsonObject }.single {
            it["update"]?.jsonObject?.get("name")?.jsonPrimitive?.content?.endsWith("/kin_care_sessions/s1") == true
        }

    @Test
    fun theSessionWriteClearsKinTaleDueInTheSameCommit() {
        val write = sessionWrite(send())
        val fields = write["update"]!!.jsonObject["fields"]!!.jsonObject
        assertEquals(false, fields["kinTaleDue"]?.jsonObject?.get("booleanValue")?.jsonPrimitive?.booleanOrNull)
        val mask = write["updateMask"]!!.jsonObject["fieldPaths"]!!.jsonArray.map { it.jsonPrimitive.content }
        assertTrue("kinTaleDue" in mask, "mask was $mask")
    }

    @Test
    fun theRunningTotalsAndTheLegacyFlagAreStillWritten() {
        val write = sessionWrite(send())
        val fields = write["update"]!!.jsonObject["fields"]!!.jsonObject
        // Installed Android builds still read it.
        assertEquals(true, fields["autoCompleteEligible"]?.jsonObject?.get("booleanValue")?.jsonPrimitive?.booleanOrNull)
        val transforms = write["updateTransforms"]!!.jsonArray.map { it.jsonObject["fieldPath"]!!.jsonPrimitive.content }
        assertEquals(listOf("reportIds", "sentReportCount"), transforms)
    }

    @Test
    fun theSendNeverAsksForTheVisitToBeCompleted() {
        send()
        assertTrue(JvmFirestoreFixtures.callablePayloads.none { it.first == "transitionBookingStatus" })
        assertFalse(fs.posts.any { it.first.contains("transitionBookingStatus") })
    }

    @Test
    fun aRefusedCommitIsAFailedSend() {
        // No stand-in: no token, so the commit is never attempted and the send says so.
        val r = runBlocking { platformMarkKinTaleReportSent("r1", "s1", "pending", "", "2026-11-12T18:00:00Z") }
        assertEquals(WriteResult.Err("Not signed in"), r)
    }
}
