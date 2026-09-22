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
import kotlin.test.assertTrue

/**
 * #889 review, item 5: MockEngine tests per call site, asserting the exact
 * outgoing URL, with the emulator switches set and with them unset.
 * guardRequests = false on the mock client: a MockEngine has no real network
 * for the :jvmTest guard to protect, and the production-host case here would
 * otherwise trip it before the mock ever saw the URL.
 */
class RestAuthClientUrlTest {

    private fun endpoints(emulator: Boolean): RestEndpoints {
        val vars = mapOf(
            "FIREBASE_AUTH_EMULATOR_HOST" to "127.0.0.1:9099",
            "FUNCTIONS_EMULATOR_HOST" to "127.0.0.1:5001",
        )
        return RestEndpoints(env = { if (emulator) vars[it] else null })
    }

    private fun clientCapturing(seenUrls: MutableList<String>, bodyJson: String) =
        RestHttp.buildClient(MockEngine, guardRequests = false) {
            engine {
                addHandler { request ->
                    seenUrls += request.url.toString()
                    respond(
                        content = bodyJson,
                        status = HttpStatusCode.OK,
                        headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
                    )
                }
            }
        }

    private val signInBody = """{"localId":"u1","idToken":"tok","refreshToken":"rt","expiresIn":"3600"}"""

    @Test
    fun signInWithPasswordHitsTheAuthEmulatorWhenConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        RestAuthClient(clientCapturing(urls, signInBody), endpoints(emulator = true))
            .signInWithPassword("a@b.com", "pw")
        assertTrue(urls.single().startsWith("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword"))
    }

    @Test
    fun signInWithPasswordHitsProductionWhenNoEmulatorIsConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        RestAuthClient(clientCapturing(urls, signInBody), endpoints(emulator = false))
            .signInWithPassword("a@b.com", "pw")
        assertTrue(urls.single().startsWith("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword"))
    }

    @Test
    fun sendPasswordResetHitsTheFunctionsEmulatorWhenConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        RestAuthClient(clientCapturing(urls, "{}"), endpoints(emulator = true)).sendPasswordReset("a@b.com")
        assertEquals("http://127.0.0.1:5001/auntieos-ttpc/us-central1/requestPasswordReset", urls.single())
    }

    @Test
    fun sendPasswordResetHitsProductionWhenNoEmulatorIsConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        RestAuthClient(clientCapturing(urls, "{}"), endpoints(emulator = false)).sendPasswordReset("a@b.com")
        assertEquals("https://us-central1-auntieos-ttpc.cloudfunctions.net/requestPasswordReset", urls.single())
    }

    @Test
    fun reportFailedLoginHitsTheFunctionsEmulatorWhenConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        RestAuthClient(clientCapturing(urls, "{}"), endpoints(emulator = true)).reportFailedLogin("a@b.com")
        assertEquals("http://127.0.0.1:5001/auntieos-ttpc/us-central1/recordFailedLogin", urls.single())
    }

    @Test
    fun reportFailedLoginHitsProductionWhenNoEmulatorIsConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        RestAuthClient(clientCapturing(urls, "{}"), endpoints(emulator = false)).reportFailedLogin("a@b.com")
        assertEquals("https://us-central1-auntieos-ttpc.cloudfunctions.net/recordFailedLogin", urls.single())
    }

    // #889 review round 3, item 6: refresh, lookup, update and
    // signInWithCustomToken had no URL test, only signInWithPassword and the
    // two functionUrl-based calls did.

    private val refreshBody = """{"id_token":"tok","refresh_token":"rt","user_id":"u1","expires_in":"3600"}"""

    @Test
    fun refreshHitsTheAuthEmulatorWhenConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        RestAuthClient(clientCapturing(urls, refreshBody), endpoints(emulator = true)).refresh("rt")
        assertTrue(urls.single().startsWith("http://127.0.0.1:9099/securetoken.googleapis.com/v1/token"))
    }

    @Test
    fun refreshHitsProductionWhenNoEmulatorIsConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        RestAuthClient(clientCapturing(urls, refreshBody), endpoints(emulator = false)).refresh("rt")
        assertTrue(urls.single().startsWith("https://securetoken.googleapis.com/v1/token"))
    }

    private val lookupBody = """{"users":[{"localId":"u1"}]}"""

    @Test
    fun lookupHitsTheAuthEmulatorWhenConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        RestAuthClient(clientCapturing(urls, lookupBody), endpoints(emulator = true)).lookup("tok")
        assertTrue(urls.single().startsWith("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:lookup"))
    }

    @Test
    fun lookupHitsProductionWhenNoEmulatorIsConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        RestAuthClient(clientCapturing(urls, lookupBody), endpoints(emulator = false)).lookup("tok")
        assertTrue(urls.single().startsWith("https://identitytoolkit.googleapis.com/v1/accounts:lookup"))
    }

    private val updateBody = """{"localId":"u1"}"""

    @Test
    fun updateHitsTheAuthEmulatorWhenConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        RestAuthClient(clientCapturing(urls, updateBody), endpoints(emulator = true)).update("tok", password = "newpass123")
        assertTrue(urls.single().startsWith("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:update"))
    }

    @Test
    fun updateHitsProductionWhenNoEmulatorIsConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        RestAuthClient(clientCapturing(urls, updateBody), endpoints(emulator = false)).update("tok", password = "newpass123")
        assertTrue(urls.single().startsWith("https://identitytoolkit.googleapis.com/v1/accounts:update"))
    }

    private val customTokenBody = """{"idToken":"tok","refreshToken":"rt"}"""

    @Test
    fun signInWithCustomTokenHitsTheAuthEmulatorWhenConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        RestAuthClient(clientCapturing(urls, customTokenBody), endpoints(emulator = true)).signInWithCustomToken("ct")
        assertTrue(urls.single().startsWith("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken"))
    }

    @Test
    fun signInWithCustomTokenHitsProductionWhenNoEmulatorIsConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        RestAuthClient(clientCapturing(urls, customTokenBody), endpoints(emulator = false)).signInWithCustomToken("ct")
        assertTrue(urls.single().startsWith("https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken"))
    }
}
