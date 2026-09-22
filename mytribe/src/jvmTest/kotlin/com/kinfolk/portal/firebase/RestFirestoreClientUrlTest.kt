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

/** #889 review, item 5: MockEngine URL assertion for RestFirestoreClient reads. */
class RestFirestoreClientUrlTest {

    private fun endpoints(emulator: Boolean) = RestEndpoints(
        env = { if (emulator && it == "FIRESTORE_EMULATOR_HOST") "127.0.0.1:8080" else null },
    )

    private fun clientCapturing(seenUrls: MutableList<String>) =
        RestHttp.buildClient(MockEngine, guardRequests = false) {
            engine {
                addHandler { request ->
                    seenUrls += request.url.toString()
                    respond(
                        content = """{"fields":{}}""",
                        status = HttpStatusCode.OK,
                        headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
                    )
                }
            }
        }

    @Test
    fun getDocumentHitsTheFirestoreEmulatorWhenConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        val fc = RestFirestoreClient({ "tok" }, clientCapturing(urls), endpoints(emulator = true))
        fc.getDocument("kinfolk", "abc")
        assertEquals(
            "http://127.0.0.1:8080/v1/projects/auntieos-ttpc/databases/(default)/documents/kinfolk/abc",
            urls.single(),
        )
    }

    @Test
    fun getDocumentHitsProductionWhenNoEmulatorIsConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        val fc = RestFirestoreClient({ "tok" }, clientCapturing(urls), endpoints(emulator = false))
        fc.getDocument("kinfolk", "abc")
        assertEquals(
            "https://firestore.googleapis.com/v1/projects/auntieos-ttpc/databases/(default)/documents/kinfolk/abc",
            urls.single(),
        )
    }
}
