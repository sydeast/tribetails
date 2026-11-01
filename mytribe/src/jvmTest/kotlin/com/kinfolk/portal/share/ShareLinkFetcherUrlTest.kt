package com.kinfolk.portal.share

import com.kinfolk.portal.firebase.RestEndpoints
import com.kinfolk.portal.firebase.RestHttp
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #889 review, item 2 and item 5: JvmShareLinkFetcher used to build its own
 * HttpClient(CIO) and always call the hardcoded production base for both
 * getShareLink and addGuestKinTaleComment. This pins the fix for both.
 */
class ShareLinkFetcherUrlTest {

    private val prodBase = "https://us-central1-auntieos-ttpc.cloudfunctions.net"

    private fun endpoints(emulator: Boolean) = RestEndpoints(
        env = { if (emulator && it == "FUNCTIONS_EMULATOR_HOST") "127.0.0.1:5001" else null },
    )

    private fun clientCapturing(seenUrls: MutableList<String>, bodyJson: String, status: HttpStatusCode = HttpStatusCode.OK) =
        RestHttp.buildClient(MockEngine, guardRequests = false) {
            engine {
                addHandler { request ->
                    seenUrls += request.url.toString()
                    respond(
                        content = bodyJson,
                        status = status,
                        headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
                    )
                }
            }
        }

    @Test
    fun getShareLinkHitsTheFunctionsEmulatorWhenConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        val fetcher = JvmShareLinkFetcher(prodBase, clientCapturing(urls, "{}"), endpoints(emulator = true))
        fetcher.getShareLink("share1", null)
        assertEquals("http://127.0.0.1:5001/auntieos-ttpc/us-central1/getShareLink/share1", urls.single())
    }

    @Test
    fun getShareLinkHitsTheExplicitProdBaseWhenNoEmulatorIsConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        val fetcher = JvmShareLinkFetcher(prodBase, clientCapturing(urls, "{}"), endpoints(emulator = false))
        fetcher.getShareLink("share1", null)
        assertEquals("$prodBase/getShareLink/share1", urls.single())
    }

    @Test
    fun postGuestCommentHitsTheFunctionsEmulatorWhenConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        val fetcher = JvmShareLinkFetcher(prodBase, clientCapturing(urls, """{"commentId":"c1"}"""), endpoints(emulator = true))
        fetcher.postGuestComment("tok", "tale1", "hi", "Guest", "g@x.com", "captcha", null, null)
        assertEquals("http://127.0.0.1:5001/auntieos-ttpc/us-central1/addGuestKinTaleComment", urls.single())
    }

    @Test
    fun postGuestCommentHitsTheExplicitProdBaseWhenNoEmulatorIsConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        val fetcher = JvmShareLinkFetcher(prodBase, clientCapturing(urls, """{"commentId":"c1"}"""), endpoints(emulator = false))
        fetcher.postGuestComment("tok", "tale1", "hi", "Guest", "g@x.com", "captcha", null, null)
        assertEquals("$prodBase/addGuestKinTaleComment", urls.single())
    }

    /**
     * #889 review round 3, item 3: gates on the Functions emulator switch
     * specifically, see SecureResetFetcherUrlTest for the full reasoning.
     * Uses a distinctive custom base, not the literal cloudfunctions.net
     * string, so this is not accidentally satisfied by functionsBase()'s own
     * (separately fixed) production branch producing the same URL.
     */
    @Test
    fun getShareLinkStaysOnTheExplicitProdBaseWhenOnlyFirestoreEmulatorIsConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        val customBase = "https://custom-share-link-base.example"
        val endpoints = RestEndpoints(
            env = {
                when (it) {
                    "FIRESTORE_EMULATOR_HOST" -> "127.0.0.1:8080"
                    "GCLOUD_PROJECT" -> "demo-x"
                    else -> null
                }
            },
        )
        val fetcher = JvmShareLinkFetcher(customBase, clientCapturing(urls, "{}"), endpoints)
        fetcher.getShareLink("share1", null)
        assertEquals("$customBase/getShareLink/share1", urls.single())
    }

    // #1331 / #1332: method and body, not just the URL.
    private data class Seen(val method: String, val url: String, val body: String)

    private fun clientRecording(seen: MutableList<Seen>, bodyJson: String) =
        RestHttp.buildClient(MockEngine, guardRequests = false) {
            engine {
                addHandler { request ->
                    seen += Seen(request.method.value, request.url.toString(), request.body.toByteArray().decodeToString())
                    respond(
                        content = bodyJson,
                        status = HttpStatusCode.OK,
                        headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
                    )
                }
            }
        }

    @Test
    fun getShareLinkPostsThePasscodeInTheBodyAndReturnsTheUnlockToken() = runBlocking {
        val seen = mutableListOf<Seen>()
        val fetcher = JvmShareLinkFetcher(
            prodBase,
            clientRecording(seen, """{"body":"x","unlockToken":"v1.1.sig"}"""),
            endpoints(emulator = false),
        )
        val result = fetcher.getShareLink("share1", "1234")
        val req = seen.single()
        assertEquals("POST", req.method)
        assertEquals("$prodBase/getShareLink/share1", req.url)
        assertFalse(req.url.contains("1234"))
        assertTrue(req.body.contains("\"passcode\":\"1234\""), req.body)
        val ok = result as GetShareLinkResult.Ok
        assertEquals("v1.1.sig", ok.unlockToken)
        assertFalse(ok.payload.containsKey("unlockToken"))
    }

    @Test
    fun getShareLinkWithoutAPasscodeIsAPlainGet() = runBlocking {
        val seen = mutableListOf<Seen>()
        val fetcher = JvmShareLinkFetcher(prodBase, clientRecording(seen, "{}"), endpoints(emulator = false))
        fetcher.getShareLink("share1", null)
        assertEquals("GET", seen.single().method)
        assertEquals("$prodBase/getShareLink/share1", seen.single().url)
    }

    @Test
    fun postGuestCommentSendsTheUnlockTokenInTheBody() = runBlocking {
        val seen = mutableListOf<Seen>()
        val fetcher = JvmShareLinkFetcher(prodBase, clientRecording(seen, """{"commentId":"c1"}"""), endpoints(emulator = false))
        fetcher.postGuestComment("tok", "tale1", "hi", "Guest", "g@x.com", "captcha", null, "v1.1.sig")
        val req = seen.single()
        assertEquals("POST", req.method)
        assertEquals("$prodBase/addGuestKinTaleComment", req.url)
        assertTrue(req.body.contains("\"unlockToken\":\"v1.1.sig\""), req.body)
    }
}
