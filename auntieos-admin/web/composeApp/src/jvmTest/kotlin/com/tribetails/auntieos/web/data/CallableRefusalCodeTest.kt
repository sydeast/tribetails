package com.tribetails.auntieos.web.data

import com.sun.net.httpserver.HttpServer
import io.ktor.client.HttpClient
import io.ktor.client.engine.java.Java
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.api.Send
import io.ktor.client.plugins.api.createClientPlugin
import io.ktor.http.URLProtocol
import kotlinx.coroutines.runBlocking
import java.net.InetSocketAddress
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #1145: a callable refusal carries a machine `details.code` (`booking_busy_conflict`,
 * `visit_overlap_conflict`, a closed day's `company_holiday_conflict`). The console used to
 * keep only the sentence, so it could not tell a refusal the operator may approve over from
 * one they may not. The code now rides on [WriteResult.Err].
 *
 * Uses a signed-out callable so the call is made with no sign-in, the way
 * [SignedOutCallablesTest] does.
 */
class CallableRefusalCodeTest {

    @Volatile private var replyStatus = 400
    @Volatile private var replyBody = ""
    private lateinit var server: HttpServer

    @BeforeTest
    fun startServer() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            ex.requestBody.readBytes()
            val bytes = replyBody.encodeToByteArray()
            ex.responseHeaders.add("Content-Type", "application/json")
            ex.sendResponseHeaders(replyStatus, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
        val port = server.address.port
        val toLocal = createClientPlugin("ToLocalServer") {
            on(Send) { request ->
                request.url.protocol = URLProtocol.HTTP
                request.url.host = "127.0.0.1"
                request.url.port = port
                proceed(request)
            }
        }
        val client = HttpClient(Java) {
            install(toLocal)
            install(HttpTimeout) { requestTimeoutMillis = 5_000 }
        }
        JvmFirestoreFixtures.restTransport = RestTestTransport(client, "http://127.0.0.1:$port/unused", "unused-firestore-token")
    }

    @AfterTest
    fun stopServer() {
        JvmFirestoreFixtures.clear()
        server.stop(0)
    }

    @Test
    fun aRefusalKeepsItsDetailsCode() = runBlocking {
        replyBody = """{"error":{"message":"That time overlaps a visit.","status":"FAILED_PRECONDITION","details":{"code":"visit_overlap_conflict","attempt":"approve"}}}"""
        val r = JvmFirestoreRest.callable("recordFailedLogin", "{}")
        assertTrue(r is WriteResult.Err)
        assertEquals("That time overlaps a visit.", r.message)
        assertEquals("visit_overlap_conflict", r.code)
    }

    @Test
    fun aRefusalWithNoDetailsHasNoCode() = runBlocking {
        replyBody = """{"error":{"message":"Something odd","status":"INTERNAL"}}"""
        val r = JvmFirestoreRest.callable("recordFailedLogin", "{}")
        assertTrue(r is WriteResult.Err)
        assertEquals("Something odd", r.message)
        assertNull(r.code)
    }
}
