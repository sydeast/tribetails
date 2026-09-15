package com.tribetails.auntieos.web.data

import io.ktor.http.URLProtocol
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import java.net.ServerSocket
import java.net.Socket
import kotlin.concurrent.thread
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * #867 review: what a screen gets back when a desktop write or n8n call fails.
 * A timeout reads as [AUNTIE_TIMEOUT_MESSAGE] on every path, and a signed-out
 * write says "Not signed in" instead of "archive failed".
 */
class DesktopErrorPathTest {

    private val captured = mutableListOf<String>()
    private val defaultOnBlocked = NetworkGuard.onBlocked

    @AfterTest
    fun tearDown() {
        NetworkGuard.onBlocked = defaultOnBlocked
        JvmFirestoreFixtures.clear()
    }

    /** A local server that accepts connections and never answers. */
    private fun <T> withSilentServer(block: suspend (port: Int) -> T): T = ServerSocket(0).use { server ->
        val held = mutableListOf<Socket>()
        thread(isDaemon = true) { runCatching { while (true) held += server.accept() } }
        try {
            runBlocking { block(server.localPort) }
        } finally {
            held.forEach { runCatching { it.close() } }
        }
    }

    // ── finding 2: the write actuals that built their own result ─────────────

    @Test
    fun aWriteActualGivenASlowServerReturnsTheTimeoutMessage() = withSilentServer { port ->
        JvmFirestoreFixtures.restTransport = RestTestTransport(
            http = auntieHttpClient(requestTimeoutMs = 300),
            base = "http://127.0.0.1:$port/v1/projects/p/databases/(default)/documents",
            token = "test-token",
        )
        assertEquals(WriteResult.Err(AUNTIE_TIMEOUT_MESSAGE), platformSaveUserProfile(UserProfile(uid = "u1")))
        assertEquals(WriteResult.Err(AUNTIE_TIMEOUT_MESSAGE), platformCreateKin(Kin(_id = "", kinfolkId = "kf1")))
        assertEquals(JvmFirestoreFixtures.lastWrite?.op, "POST")
    }

    @Test
    fun transportResultMapsFailuresAndLetsTheGuardThrough() = runBlocking {
        assertEquals(WriteResult.Ok("id1"), transportResult("create failed") { WriteResult.Ok("id1") })
        assertEquals(WriteResult.Err("refused"), transportResult<String>("create failed") { WriteResult.Err("refused") })
        assertEquals(WriteResult.Err("boom"), transportResult<String>("create failed") { error("boom") })
        assertFailsWith<NetworkBlockedError> { transportResult<String>("create failed") { throw NetworkBlockedError("x") } }
        Unit
    }

    /** Every actual that built its own result used runCatching + it.message, which showed Ktor's timeout text. */
    @Test
    fun noWriteActualShowsARawExceptionMessage() {
        val source = File("src/jvmMain/kotlin/com/tribetails/auntieos/web/data/FirestoreInterop.jvm.kt").readText()
        assertTrue(!source.contains("getOrElse { WriteResult.Err(it.message"), "a write actual still maps a throw to it.message")
    }

    // ── finding 3: no token on the three Boolean REST writes ────────────────

    @Test
    fun theBooleanRestWritesSayNotSignedInWithNoToken() = runBlocking {
        NetworkGuard.onBlocked = { captured += it }
        assertEquals("Not signed in", assertFailsWith<IllegalStateException> { JvmFirestoreRest.deleteDoc("kintale_templates", "t1") }.message)
        assertEquals("Not signed in", assertFailsWith<IllegalStateException> { JvmFirestoreRest.patchFields("kin", "k1", mapOf("status" to JsonPrimitive("archived"))) }.message)
        assertEquals("Not signed in", assertFailsWith<IllegalStateException> { JvmFirestoreRest.markReportSentAtomic("r1", "s1", "email", "d1", "2026-09-14T00:00:00Z", "2026-09-14T00:00:00Z") }.message)
        assertTrue(captured.isEmpty(), "a request was attempted with no token: $captured")
    }

    @Test
    fun anExpiredSessionReadsAsNotSignedInOnTheScreensThatArchiveDeleteAndMarkSent() = runBlocking {
        NetworkGuard.onBlocked = { captured += it }
        assertEquals(WriteResult.Err("Not signed in"), platformDeleteKinTaleTemplate("t1"))
        assertEquals(RestWrite("DELETE", "kintale_templates", "t1"), JvmFirestoreFixtures.lastWrite)
        assertEquals(WriteResult.Err("Not signed in"), platformArchiveKinfolk("kf1"))
        assertEquals(RestWrite("PATCH", "kinfolk", "kf1", setOf("status")), JvmFirestoreFixtures.lastWrite)
        assertEquals(WriteResult.Err("Not signed in"), platformMarkKinTaleReportSent("r1", "s1", "email", "d1", "2026-09-14T00:00:00Z"))
        assertEquals(WriteResult.Err("Not signed in"), platformDeleteVetClinic("v1"))
        assertTrue(captured.isEmpty(), "a request was attempted with no token: $captured")
    }

    // ── finding 4: n8n ───────────────────────────────────────────────────────

    @Test
    fun anN8nGenerateThatTimesOutSaysSoPlainly() = withSilentServer { port ->
        val client = N8nClient(n8nHttpClient(requestTimeoutMs = 300, protocol = URLProtocol.HTTP, host = "127.0.0.1", port = port))
        val e = assertFailsWith<IllegalStateException> {
            client.generate(GenerateRequest(CommunicationType.SMS, recipient = "Pat", raw_notes = "walk"), useFunction = false)
        }
        assertEquals(AUNTIE_TIMEOUT_MESSAGE, e.message)
    }

    @Test
    fun theTimeoutMappingLivesInCommonCode() {
        val wrapped = RuntimeException("outer", io.ktor.client.plugins.HttpRequestTimeoutException("http://x", 1L))
        assertEquals(AUNTIE_TIMEOUT_MESSAGE, wrapped.transportMessage("fallback"))
        assertEquals("plain", RuntimeException("plain").transportMessage("fallback"))
        assertEquals("fallback", RuntimeException().transportMessage("fallback"))
    }
}
