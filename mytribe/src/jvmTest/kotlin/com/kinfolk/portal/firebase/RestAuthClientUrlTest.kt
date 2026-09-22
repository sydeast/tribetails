package com.kinfolk.portal.firebase

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.OutgoingContent
import io.ktor.http.headersOf
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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

    // #911: the reset send moved off the requestPasswordReset callable and onto
    // Identity Toolkit's own accounts:sendOobCode, so it now follows the AUTH
    // emulator switch (9099) rather than the FUNCTIONS one (5001).

    @Test
    fun sendPasswordResetHitsTheAuthEmulatorWhenConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        RestAuthClient(clientCapturing(urls, "{}"), endpoints(emulator = true)).sendPasswordReset("a@b.com")
        assertTrue(
            urls.single().startsWith("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:sendOobCode"),
            "expected the Auth emulator's sendOobCode, got ${urls.single()}",
        )
    }

    @Test
    fun sendPasswordResetHitsProductionWhenNoEmulatorIsConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        RestAuthClient(clientCapturing(urls, "{}"), endpoints(emulator = false)).sendPasswordReset("a@b.com")
        assertTrue(
            urls.single().startsWith("https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode"),
            "expected production sendOobCode, got ${urls.single()}",
        )
    }

    /** The whole body, so a dropped field cannot pass as a URL that still looks right. */
    @Test
    fun sendPasswordResetPostsAPasswordResetRequestThatContinuesToThePortalSignIn() = runBlocking {
        val bodies = mutableListOf<String>()
        val client = RestHttp.buildClient(MockEngine, guardRequests = false) {
            engine {
                addHandler { request ->
                    bodies += (request.body as OutgoingContent.ByteArrayContent).bytes().decodeToString()
                    respond(
                        content = "{}",
                        status = HttpStatusCode.OK,
                        headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
                    )
                }
            }
        }
        RestAuthClient(client, endpoints(emulator = true)).sendPasswordReset("  Pat@Household.test  ")
        val body = RestHttp.json.parseToJsonElement(bodies.single()).jsonObject
        assertEquals("PASSWORD_RESET", body["requestType"]?.jsonPrimitive?.content)
        assertEquals("Pat@Household.test", body["email"]?.jsonPrimitive?.content)
        assertEquals("https://kinfolk.tribetails.com/signin", body["continueUrl"]?.jsonPrimitive?.content)
        assertEquals("false", body["canHandleCodeInApp"]?.jsonPrimitive?.content)
    }

    /**
     * #936: a null target leaves both link fields OUT of the body rather than
     * writing them as JSON null. `explicitNulls = false` in [RestHttp.json] is
     * what makes that true, and a change to that setting would turn this body
     * into one Identity Toolkit reads differently.
     */
    @Test
    fun aNullTargetPostsNoContinueUrlAtAll() = runBlocking {
        val bodies = mutableListOf<String>()
        val client = RestHttp.buildClient(MockEngine, guardRequests = false) {
            engine {
                addHandler { request ->
                    bodies += (request.body as OutgoingContent.ByteArrayContent).bytes().decodeToString()
                    respond(
                        content = "{}",
                        status = HttpStatusCode.OK,
                        headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
                    )
                }
            }
        }
        RestAuthClient(client, endpoints(emulator = true)).sendPasswordReset("pat@household.test", null)
        val body = RestHttp.json.parseToJsonElement(bodies.single()).jsonObject
        assertEquals("PASSWORD_RESET", body["requestType"]?.jsonPrimitive?.content)
        assertTrue("continueUrl" !in body, "expected no continueUrl key, got ${bodies.single()}")
        assertTrue("canHandleCodeInApp" !in body, "expected no canHandleCodeInApp key, got ${bodies.single()}")
    }
    /** A target the caller names is the one that goes on the wire. */
    @Test
    fun theCallersTargetIsTheOneThatIsPosted() = runBlocking {
        val bodies = mutableListOf<String>()
        val client = RestHttp.buildClient(MockEngine, guardRequests = false) {
            engine {
                addHandler { request ->
                    bodies += (request.body as OutgoingContent.ByteArrayContent).bytes().decodeToString()
                    respond(
                        content = "{}",
                        status = HttpStatusCode.OK,
                        headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
                    )
                }
            }
        }
        RestAuthClient(client, endpoints(emulator = true))
            .sendPasswordReset("staff@tribetails.com", "https://auntie.tribetails.com/signin")
        val body = RestHttp.json.parseToJsonElement(bodies.single()).jsonObject
        assertEquals("https://auntie.tribetails.com/signin", body["continueUrl"]?.jsonPrimitive?.content)
        assertEquals("false", body["canHandleCodeInApp"]?.jsonPrimitive?.content)
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
