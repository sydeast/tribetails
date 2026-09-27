package com.tribetails.auntieos.web.data

import com.sun.net.httpserver.HttpServer
import io.ktor.client.HttpClient
import io.ktor.client.engine.java.Java
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.api.Send
import io.ktor.client.plugins.api.createClientPlugin
import io.ktor.http.URLProtocol
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * #955: the desktop may call `recordFailedLogin` and `requestPasswordReset` with no
 * ID token, and nothing else.
 *
 * A local server stands in for Cloud Functions. The test client rewrites every
 * request to it (the production URL never leaves the process), and records the path,
 * the Authorization header and the body the server received. No test here signs in,
 * so `jvmFirebaseIdToken()` is null throughout.
 */
class SignedOutCallablesTest {

    private data class Received(val path: String, val authorization: String?, val body: String)

    private val received = CopyOnWriteArrayList<Received>()
    private var arrived = CountDownLatch(1)
    @Volatile private var replyStatus = 200
    @Volatile private var replyBody = """{"result":{"ok":true}}"""
    private lateinit var server: HttpServer

    @BeforeTest
    fun startServer() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            received += Received(
                path = ex.requestURI.path,
                authorization = ex.requestHeaders.getFirst("Authorization"),
                body = ex.requestBody.readBytes().decodeToString(),
            )
            val bytes = replyBody.encodeToByteArray()
            ex.responseHeaders.add("Content-Type", "application/json")
            ex.sendResponseHeaders(replyStatus, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
            arrived.countDown()
        }
        server.start()
        val port = server.address.port
        // Sends every request to the local server, whatever host it named.
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
    fun theAllowListIsExactlyTheTwoSignedOutCallables() {
        assertEquals(setOf("recordFailedLogin", "requestPasswordReset"), JvmFirestoreRest.SIGNED_OUT_CALLABLES)
    }

    @Test
    fun aFailedSignIn_sendsRecordFailedLogin_withNoToken() {
        val auth = AuthClient(
            signInImpl = { _, _ -> SignInResult.Failure("auth/invalid-credential") },
            reportScope = CoroutineScope(Dispatchers.Unconfined),
        )
        val result = runBlocking { withTimeout(5_000) { auth.signIn("  auntie@tribetails.test ", "guess") } }
        assertEquals(SignInResult.Failure("auth/invalid-credential"), result)

        assertTrue(arrived.await(5, TimeUnit.SECONDS), "recordFailedLogin never reached the server")
        val r = received.single()
        assertEquals("/recordFailedLogin", r.path)
        assertNull(r.authorization, "a signed-out report must not carry a token")
        assertEquals("""{"data":{"email":"auntie@tribetails.test"}}""", r.body)
    }

    @Test
    fun aPasswordReset_sendsRequestPasswordReset_withNoToken_andTheWebPayload() = runBlocking {
        val result = AuthClient().sendPasswordReset("  auntie@tribetails.test ")
        assertEquals(PasswordResetResult.Sent, result)
        val r = received.single()
        assertEquals("/requestPasswordReset", r.path)
        assertNull(r.authorization, "a signed-out reset must not carry a token")
        // Same payload as admin web (`sendReset`) and Android: the trimmed address and nothing else.
        assertEquals("""{"data":{"email":"auntie@tribetails.test"}}""", r.body)
    }

    @Test
    fun aRefusedReset_showsTheSameSentencesAsAndroid() = runBlocking {
        replyStatus = 429
        replyBody = """{"error":{"message":"Too many requests from this network.","status":"RESOURCE_EXHAUSTED"}}"""
        assertEquals(PasswordResetResult.Failed(RESET_TOO_MANY_MSG), AuthClient().sendPasswordReset("auntie@tribetails.test"))

        replyStatus = 400
        replyBody = """{"error":{"message":"email (valid email address) is required","status":"INVALID_ARGUMENT"}}"""
        assertEquals(PasswordResetResult.Failed(RESET_INVALID_EMAIL_MSG), AuthClient().sendPasswordReset("auntie@tribetails.test"))

        replyStatus = 500
        replyBody = """{"error":{"message":"Something odd","status":"INTERNAL"}}"""
        assertEquals(PasswordResetResult.Failed("Something odd"), AuthClient().sendPasswordReset("auntie@tribetails.test"))
    }

    @Test
    fun aResetThatNeverGetsAnAnswer_saysNetwork() = runBlocking {
        server.stop(0)
        assertEquals(PasswordResetResult.Failed(RESET_NETWORK_MSG), AuthClient().sendPasswordReset("auntie@tribetails.test"))
    }

    @Test
    fun aBlankResetAddress_sendsNothing() = runBlocking {
        assertEquals(PasswordResetResult.Failed(RESET_INVALID_EMAIL_MSG), AuthClient().sendPasswordReset("   "))
        assertTrue(received.isEmpty(), "sent: $received")
    }

    @Test
    fun everyOtherCallable_withNoToken_isStillRefusedAndSendsNothing() = runBlocking {
        for (name in listOf("listFormSchemas", "broadcastMessage", "recordfailedlogin", "requestPasswordReset ", "")) {
            assertEquals(WriteResult.Err("Not signed in"), JvmFirestoreRest.callable(name, "{}"), "'$name'")
        }
        assertTrue(received.isEmpty(), "a callable went out with no token: $received")
    }
}
