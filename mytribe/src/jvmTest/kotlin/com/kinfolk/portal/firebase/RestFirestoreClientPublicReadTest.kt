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
import kotlin.test.assertNull

/**
 * #1321: the desktop reads `business_public/card` before anyone is signed in.
 * With no session the request carries no Authorization header, so a
 * rules-public document answers; a protected one answers 403 and still reads
 * as null, which is what a signed-out read always returned.
 */
class RestFirestoreClientPublicReadTest {

    private val endpoints = RestEndpoints(env = { null })

    private fun client(status: HttpStatusCode, body: String, seenAuth: MutableList<String?>) =
        RestHttp.buildClient(MockEngine, guardRequests = false) {
            engine {
                addHandler { request ->
                    seenAuth += request.headers[HttpHeaders.Authorization]
                    respond(
                        content = body,
                        status = status,
                        headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
                    )
                }
            }
        }

    @Test
    fun aSignedOutReadGoesOutWithoutABearerAndDecodesAPublicDocument() = runBlocking {
        val auth = mutableListOf<String?>()
        val fc = RestFirestoreClient(
            { null },
            client(HttpStatusCode.OK, """{"fields":{"name":{"stringValue":"Sunny Paws"}}}""", auth),
            endpoints,
        )
        val doc = fc.getDocument("business_public", "card")
        assertEquals(listOf<String?>(null), auth)
        assertEquals("Sunny Paws", doc?.get("name"))
    }

    @Test
    fun aSignedOutReadOfAProtectedDocumentStillReadsAsNull() = runBlocking {
        val auth = mutableListOf<String?>()
        val fc = RestFirestoreClient({ null }, client(HttpStatusCode.Forbidden, """{"error":{}}""", auth), endpoints)
        assertNull(fc.getDocument("business_settings", "business_settings"))
    }

    @Test
    fun aSignedInReadStillCarriesTheBearer() = runBlocking {
        val auth = mutableListOf<String?>()
        val fc = RestFirestoreClient({ "tok" }, client(HttpStatusCode.OK, """{"fields":{}}""", auth), endpoints)
        fc.getDocument("business_public", "card")
        assertEquals(listOf<String?>("Bearer tok"), auth)
    }
}
