package com.kinfolk.portal.share

import com.kinfolk.portal.firebase.RestEndpoints
import com.kinfolk.portal.firebase.RestHttp
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals

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
        fetcher.postGuestComment("tok", "tale1", "hi", "Guest", "g@x.com", "captcha", null)
        assertEquals("http://127.0.0.1:5001/auntieos-ttpc/us-central1/addGuestKinTaleComment", urls.single())
    }

    @Test
    fun postGuestCommentHitsTheExplicitProdBaseWhenNoEmulatorIsConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        val fetcher = JvmShareLinkFetcher(prodBase, clientCapturing(urls, """{"commentId":"c1"}"""), endpoints(emulator = false))
        fetcher.postGuestComment("tok", "tale1", "hi", "Guest", "g@x.com", "captcha", null)
        assertEquals("$prodBase/addGuestKinTaleComment", urls.single())
    }
}
