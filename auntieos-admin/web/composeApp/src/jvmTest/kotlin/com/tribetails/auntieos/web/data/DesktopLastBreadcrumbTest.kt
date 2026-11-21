package com.tribetails.auntieos.web.data

import com.sun.net.httpserver.HttpServer
import com.tribetails.auntieos.web.screens.sessions.gpsLineFor
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.datetime.TimeZone
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.net.InetSocketAddress
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #2386: the console's Arrived card reads the visit's newest ping on its own
 * (it used to get no breadcrumbs at all, so it drew no GPS line). A local HTTP
 * server stands in for Firestore REST and records the query the console sends.
 */
class DesktopLastBreadcrumbTest {

    private lateinit var server: HttpServer
    private val queries = mutableListOf<Pair<String, JsonObject>>()
    private var answer: String = "[]"
    private var status: Int = 200

    // 2026-11-17 20:05 UTC.
    private val at = 1_794_945_900_000L

    @BeforeTest
    fun setUp() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            val path = ex.requestURI.rawPath.substringAfter("/documents")
            val body = ex.requestBody.readBytes().decodeToString()
            if (ex.requestMethod == "POST") synchronized(queries) { queries += path to Json.parseToJsonElement(body).jsonObject }
            val bytes = answer.encodeToByteArray()
            ex.sendResponseHeaders(status, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
        JvmFirestoreFixtures.restTransport = RestTestTransport(
            http = auntieHttpClient(requestTimeoutMs = 5_000),
            base = "http://127.0.0.1:${server.address.port}/v1/projects/p/databases/(default)/documents",
            token = "test-token",
        )
    }

    @AfterTest
    fun tearDown() {
        JvmFirestoreFixtures.clear()
        server.stop(0)
    }

    private fun row(id: String, fields: JsonObject) = buildJsonArray {
        add(buildJsonObject {
            put("document", buildJsonObject {
                put("name", "projects/p/databases/(default)/documents/kin_care_sessions/s1/breadcrumbs/$id")
                put("fields", fields)
            })
        })
    }.toString()

    @Test
    fun asksForTheNewestNumericPingOfThatVisitOnly() = runBlocking {
        answer = row("c9", buildJsonObject {
            put("latitude", buildJsonObject { put("doubleValue", 30.25) })
            put("longitude", buildJsonObject { put("doubleValue", -97.75) })
            put("timestamp", buildJsonObject { put("integerValue", at.toString()) })
        })
        val got = FirestoreClient().lastBreadcrumbStream("s1").first()

        val (path, body) = queries.single()
        assertEquals("/kin_care_sessions/s1:runQuery", path)
        val q = body["structuredQuery"]!!.jsonObject
        assertEquals("breadcrumbs", q["from"]!!.jsonArray.single().jsonObject["collectionId"]!!.jsonPrimitive.content)
        val filter = q["where"]!!.jsonObject["fieldFilter"]!!.jsonObject
        assertEquals("timestamp", filter["field"]!!.jsonObject["fieldPath"]!!.jsonPrimitive.content)
        assertEquals("GREATER_THAN_OR_EQUAL", filter["op"]!!.jsonPrimitive.content)
        val order = q["orderBy"]!!.jsonArray.single().jsonObject
        assertEquals("DESCENDING", order["direction"]!!.jsonPrimitive.content)
        assertEquals("1", q["limit"]!!.jsonPrimitive.content)

        val crumbs = (got as FirestoreResult.Data).value
        assertEquals(listOf(Breadcrumb(_id = "c9", timestamp = at.toString(), lat = 30.25, lng = -97.75)), crumbs)
        // And the card reads it as the live route a minute later.
        val line = gpsLineFor(false, crumbs, TimeZone.of("America/Chicago"), nowMs = at + 60_000)!!
        assertEquals("GPS tracking · live route", line.text)
        assertTrue(line.live)
    }

    @Test
    fun noPingIsAnEmptyListSoTheCardSaysNoneYet() = runBlocking {
        answer = """[{"readTime":"2026-11-17T20:05:00Z"}]"""
        val got = FirestoreClient().lastBreadcrumbStream("s1").first()
        assertEquals(emptyList(), (got as FirestoreResult.Data).value)
    }

    @Test
    fun aRefusedReadIsAnErrorSoTheCardSaysNothing() = runBlocking {
        status = 403
        answer = """{"error":{"status":"PERMISSION_DENIED"}}"""
        val got = FirestoreClient().lastBreadcrumbStream("s1").first()
        assertTrue(got is FirestoreResult.Error)
    }

    @Test
    fun theDecoderTakesBothShapesAndKeepsTheClockAsWholeMillis() {
        val android = breadcrumbFromPlain(buildJsonObject {
            put("_id", "a")
            put("latitude", 30.0)
            put("longitude", -97.0)
            put("timestamp", 1.7949459E12)
        })
        assertEquals("1794945900000", android.timestamp)
        assertEquals(30.0, android.lat)
        val legacy = breadcrumbFromPlain(buildJsonObject {
            put("lat", 31.0)
            put("lng", -98.0)
            put("timestamp", "2026-11-17T20:05:00Z")
        })
        assertEquals("2026-11-17T20:05:00Z", legacy.timestamp)
        assertEquals(-98.0, legacy.lng)
        assertEquals("", breadcrumbFromPlain(buildJsonObject { put("timestamp", JsonPrimitive(null as String?)) }).timestamp)
    }
}
