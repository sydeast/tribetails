package com.kinfolk.portal.firebase

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals

/** #889 review, item 5: MockEngine URL assertion for RestFunctionsClient.call. */
class RestFunctionsClientUrlTest {

    private fun endpoints(emulator: Boolean) = RestEndpoints(
        env = { if (emulator && it == "FUNCTIONS_EMULATOR_HOST") "127.0.0.1:5001" else null },
    )

    private fun clientCapturing(seenUrls: MutableList<String>) =
        RestHttp.buildClient(MockEngine, guardRequests = false) {
            engine {
                addHandler { request ->
                    seenUrls += request.url.toString()
                    respond(
                        content = """{"result":{"ok":true}}""",
                        status = HttpStatusCode.OK,
                        headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
                    )
                }
            }
        }

    @Test
    fun callHitsTheFunctionsEmulatorWhenConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        val fn = RestFunctionsClient({ "tok" }, clientCapturing(urls), endpoints(emulator = true))
        fn.call("getMyHome", null)
        assertEquals("http://127.0.0.1:5001/auntieos-ttpc/us-central1/getMyHome", urls.single())
    }

    @Test
    fun callHitsProductionWhenNoEmulatorIsConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        val fn = RestFunctionsClient({ "tok" }, clientCapturing(urls), endpoints(emulator = false))
        fn.call("getMyHome", null)
        assertEquals("https://us-central1-auntieos-ttpc.cloudfunctions.net/getMyHome", urls.single())
    }
}
