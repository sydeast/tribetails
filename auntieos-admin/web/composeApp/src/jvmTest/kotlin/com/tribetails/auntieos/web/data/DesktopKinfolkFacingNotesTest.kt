package com.tribetails.auntieos.web.data

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.InetSocketAddress
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #2227: the console's kinfolk-facing notes list used to be a stub that always
 * answered an error. It now reads the thread the server writes and the visit's
 * Accept and Decline notes. A local HTTP server stands in for Firestore REST.
 */
class DesktopKinfolkFacingNotesTest {

    private lateinit var server: HttpServer
    private val gets = mutableListOf<String>()
    /** Path under /documents to (status, body). */
    private val answers = mutableMapOf<String, Pair<Int, String>>()

    @BeforeTest
    fun setUp() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            val path = ex.requestURI.rawPath.substringAfter("/documents")
            synchronized(gets) { gets += path }
            val (status, body) = answers[path] ?: (404 to """{"error":{"status":"NOT_FOUND"}}""")
            val bytes = body.encodeToByteArray()
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

    private val visitPath = "/families/kf1/bookings/b1/kinCares/v1"

    private fun doc(path: String, fields: String) =
        """{"name":"projects/p/databases/(default)/documents$path","fields":{$fields}}"""

    @Test
    fun readsTheThreadUnderTheVisitAndTheOfficesAnswerNote() = runBlocking {
        answers["$visitPath/notes"] = 200 to """{"documents":[
            ${doc("$visitPath/notes/n2", """"authorRole":{"stringValue":"admin"},"authorUid":{"stringValue":"u1"},"body":{"stringValue":"Bring the blue leash"},"createdAt":{"timestampValue":"2026-11-17T20:10:00Z"}""")},
            ${doc("$visitPath/notes/n1", """"authorRole":{"stringValue":"kinfolk"},"body":{"stringValue":"Side gate code changed"},"createdAt":{"timestampValue":"2026-11-17T20:05:00Z"}""")}
        ]}"""
        answers[visitPath] = 200 to doc(visitPath, """"requestAcceptNote":{"stringValue":"See you Tuesday"},"requestAcceptedAt":{"timestampValue":"2026-11-16T15:00:00Z"},"requestAcceptedBy":{"stringValue":"u1"}""")

        val got = FirestoreClient().bookingNotesStream("kf1", "b1", internal = false, visitId = "v1").first()

        val notes = (got as FirestoreResult.Data).value
        assertEquals(listOf("request-accepted", "n1", "n2"), notes.map { it._id })
        assertEquals(listOf("admin", "kinfolk", "admin"), notes.map { it.authorRole })
        assertEquals("Side gate code changed", notes[1].body)
        assertEquals(1_794_945_900_000L, notes[1].createdAtMs)
        assertTrue(gets.any { it == "$visitPath/notes" }, "reads the nested thread, got $gets")
        assertTrue(gets.none { it == "/families/kf1/bookings/b1/notes" }, "never the old flat path")
    }

    @Test
    fun aRefusedThreadReadIsAnErrorSoTheSheetOffersTryAgain() = runBlocking {
        answers["$visitPath/notes"] = 403 to """{"error":{"status":"PERMISSION_DENIED"}}"""
        val got = FirestoreClient().bookingNotesStream("kf1", "b1", internal = false, visitId = "v1").first()
        assertTrue(got is FirestoreResult.Error)
    }

    @Test
    fun aFailedVisitReadLeavesTheThreadAsItIs() = runBlocking {
        answers["$visitPath/notes"] = 200 to """{"documents":[${doc("$visitPath/notes/n1", """"authorRole":{"stringValue":"kinfolk"},"body":{"stringValue":"Hi"}""")}]}"""
        answers[visitPath] = 500 to """{"error":{"status":"INTERNAL"}}"""
        val got = FirestoreClient().bookingNotesStream("kf1", "b1", internal = false, visitId = "v1").first()
        assertEquals(listOf("n1"), (got as FirestoreResult.Data).value.map { it._id })
    }

    @Test
    fun aVisitWithNoBookingRequestReadsNothing() = runBlocking {
        val got = FirestoreClient().bookingNotesStream("kf1", "b1", internal = false, visitId = "").first()
        assertTrue(got is FirestoreResult.Error)
        assertTrue(gets.isEmpty(), "no request without both ids, got $gets")
    }

    @Test
    fun theDecoderSkipsBlankAnswersAndPutsAnUntimedRowFirst() {
        val got = kinfolkFacingNotesFromPlain(
            thread = listOf(
                buildJsonObject { put("_id", "late"); put("body", "b"); put("createdAt", "2026-11-17T20:05:00Z") },
                buildJsonObject { put("_id", "pending"); put("body", "a"); put("createdAt", JsonPrimitive(null as String?)) },
            ),
            visit = buildJsonObject { put("requestAcceptNote", "  "); put("requestDeclineNote", "Booked up that week") },
        )
        assertEquals(listOf("request-declined", "pending", "late"), got.map { it._id })
        assertEquals("Booked up that week", got[0].body)
    }
}
