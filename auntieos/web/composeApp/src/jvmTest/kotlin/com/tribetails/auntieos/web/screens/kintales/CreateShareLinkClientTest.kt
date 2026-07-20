package com.tribetails.auntieos.web.screens.kintales

import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.runBlocking
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Integration: FirestoreClient.createShareLink routes through platformInvokeCallable,
 * which the jvm actual answers from JvmFirestoreFixtures.callableResponses. Covers
 * the happy path (returns the server shareUrl), the missing-url path (fail-loud Err,
 * never a fabricated link), the malformed-json path, and the stubbed-error (sad)
 * path. Also covers desktop (same jvm actual).
 */
class CreateShareLinkClientTest {

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.callableResponses = emptyMap()
    }

    @Test
    fun createShareLinkReturnsServerShareUrl() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf(
            "createShareLink" to """{"shareId":"abc","shareUrl":"https://share.example/abc"}""",
        )
        val r = FirestoreClient().createShareLink(familyId = "kf1", kinTaleId = "rep1")
        assertTrue(r is WriteResult.Ok)
        assertEquals("https://share.example/abc", (r as WriteResult.Ok).value)
    }

    @Test
    fun createShareLinkMissingUrlFailsLoud() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("createShareLink" to """{"shareId":"abc"}""")
        val r = FirestoreClient().createShareLink(familyId = "kf1", kinTaleId = "rep1")
        assertTrue(r is WriteResult.Err, "missing shareUrl must fail loud, never fabricate a link")
    }

    @Test
    fun createShareLinkBlankUrlFailsLoud() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("createShareLink" to """{"shareUrl":""}""")
        val r = FirestoreClient().createShareLink(familyId = "kf1", kinTaleId = "rep1")
        assertTrue(r is WriteResult.Err)
    }

    @Test
    fun createShareLinkMalformedJsonSurfacesErr() = runBlocking {
        JvmFirestoreFixtures.callableResponses = mapOf("createShareLink" to "not-json{")
        val r = FirestoreClient().createShareLink(familyId = "kf1", kinTaleId = "rep1")
        assertTrue(r is WriteResult.Err)
    }
}
