package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * Parity slice: FirestoreClient.synthesizeProfile routes through
 * platformInvokeCallable, answered on jvm (= desktop) by
 * JvmFirestoreFixtures.callableResponses. Covers the happy ack and the fail-loud
 * malformed-ack path. Mirrors the Android AuntieRepository.synthesizeProfile call
 * to the synthesize_kinfolk_profile Python callable.
 */
class SynthesizeProfileClientTest {

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.callableResponses = emptyMap()
    }

    @Test
    fun synthesizeHappyPathReturnsOk() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "synthesize_kinfolk_profile" to """{"processed":3,"kinfolkId":"kf1"}""",
        )
        val r = FirestoreClient().synthesizeProfile("kf1")
        assertTrue(r is WriteResult.Ok, "well-formed server ack must map to WriteResult.Ok")
    }

    @Test
    fun synthesizeZeroProcessedStillOk() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "synthesize_kinfolk_profile" to """{"processed":0,"kinfolkId":"kf1"}""",
        )
        val r = FirestoreClient().synthesizeProfile("kf1")
        assertTrue(r is WriteResult.Ok, "a processed:0 ack is still a successful run, not an error")
    }

    @Test
    fun synthesizeMalformedJsonSurfacesErr() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "synthesize_kinfolk_profile" to "not-json{",
        )
        val r = FirestoreClient().synthesizeProfile("kf1")
        assertTrue(r is WriteResult.Err, "a malformed server ack must fail loud, not silently succeed")
    }
}
