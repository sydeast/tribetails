package com.kinfolk.portal.firebase

import com.kinfolk.portal.auth.AuthRepository
import com.kinfolk.portal.auth.isResetRateLimited
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #905, the desktop reset driven through the real stack: [RestAuthClient]
 * posts the `requestPasswordReset` callable, the Functions endpoint answers in
 * the callable protocol's shapes, and [AuthRepository.sendPasswordReset] passes
 * on what the screen gets to see.
 *
 * [com.kinfolk.portal.auth.PasswordResetSendTest] pins the rate-limit rule on
 * plain strings. This one feeds it the real [FirebaseRestException] the REST
 * client throws, so a change to either the error shape or the client's
 * exception message shows up here.
 */
class RestAuthResetSendTest {

    private fun endpoints() = RestEndpoints(env = { mapOf("FUNCTIONS_EMULATOR_HOST" to "127.0.0.1:5001")[it] })

    private fun backendAnswering(status: HttpStatusCode, body: String): RestAuthBackend {
        val client = RestHttp.buildClient(MockEngine, guardRequests = false) {
            engine {
                addHandler {
                    respond(
                        content = body,
                        status = status,
                        headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
                    )
                }
            }
        }
        return RestAuthBackend(RestAuthClient(client, endpoints()))
    }

    /** The callable's one success shape, the same for a known and an unknown address. */
    @Test
    fun theConstantAnswerReadsAsSent() = runBlocking {
        val repo = AuthRepository(backendAnswering(HttpStatusCode.OK, """{"result":{"ok":true}}"""))
        repo.sendPasswordReset("ghost@household.test")
    }

    @Test
    fun thePerIpLimitIsThrownAndRecognised() = runBlocking {
        val repo = AuthRepository(
            backendAnswering(
                HttpStatusCode.TooManyRequests,
                """{"error":{"message":"Too many requests. Try again later.","status":"RESOURCE_EXHAUSTED"}}""",
            ),
        )
        val thrown = assertFailsWith<FirebaseRestException> { repo.sendPasswordReset("pat@household.test") }
        assertEquals(429, thrown.status)
        assertTrue(isResetRateLimited(thrown), "expected the screen to read this as the rate limit: ${thrown.message}")
    }

    @Test
    fun aMalformedAddressStillFailsAndIsNotTheLimit() = runBlocking {
        val repo = AuthRepository(
            backendAnswering(
                HttpStatusCode.BadRequest,
                """{"error":{"message":"email (valid email address) is required","status":"INVALID_ARGUMENT"}}""",
            ),
        )
        val thrown = assertFailsWith<FirebaseRestException> { repo.sendPasswordReset("not-an-email") }
        assertEquals(400, thrown.status)
        assertFalse(isResetRateLimited(thrown), "a malformed address must keep the plain failure: ${thrown.message}")
    }

    @Test
    fun aServerErrorStillFailsAndIsNotTheLimit() = runBlocking {
        val repo = AuthRepository(
            backendAnswering(HttpStatusCode.InternalServerError, """{"error":{"message":"INTERNAL","status":"INTERNAL"}}"""),
        )
        val thrown = assertFailsWith<FirebaseRestException> { repo.sendPasswordReset("pat@household.test") }
        assertEquals(500, thrown.status)
        assertFalse(isResetRateLimited(thrown))
    }
}
