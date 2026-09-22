package com.kinfolk.portal.firebase

import com.kinfolk.portal.auth.AuthRepository
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

/**
 * #911, the desktop half of the enumeration guard, driven through the real
 * stack: [RestAuthClient] posts `accounts:sendOobCode`, Identity Toolkit
 * refuses, `platformAuthErrorCode` (the JVM actual) reads the code off the
 * response body, and [AuthRepository.sendPasswordReset] decides what the screen
 * gets to see.
 *
 * [com.kinfolk.portal.auth.PasswordResetSendTest] pins the same rule with a
 * fake, which can only reach the message branch. This one reaches the code
 * branch, so a change to either the REST error shape or the JVM code reader
 * shows up here.
 */
class RestAuthResetSendTest {

    private fun endpoints() = RestEndpoints(env = { mapOf("FIREBASE_AUTH_EMULATOR_HOST" to "127.0.0.1:9099")[it] })

    private fun backendRefusing(status: HttpStatusCode, body: String): RestAuthBackend {
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

    @Test
    fun anAddressThatIsNotAnAccountNeverReachesTheScreen() = runBlocking {
        val repo = AuthRepository(
            backendRefusing(HttpStatusCode.BadRequest, """{"error":{"code":400,"message":"EMAIL_NOT_FOUND"}}"""),
        )
        repo.sendPasswordReset("ghost@household.test")
    }

    @Test
    fun aMalformedAddressStillFails() = runBlocking {
        val repo = AuthRepository(
            backendRefusing(HttpStatusCode.BadRequest, """{"error":{"code":400,"message":"INVALID_EMAIL"}}"""),
        )
        val thrown = assertFailsWith<FirebaseRestException> { repo.sendPasswordReset("not-an-email") }
        assertEquals(400, thrown.status)
    }

    @Test
    fun anAbuseRefusalStillFails() = runBlocking {
        val repo = AuthRepository(
            backendRefusing(
                HttpStatusCode.TooManyRequests,
                """{"error":{"code":429,"message":"TOO_MANY_ATTEMPTS_TRY_LATER : Try again later."}}""",
            ),
        )
        val thrown = assertFailsWith<FirebaseRestException> { repo.sendPasswordReset("pat@household.test") }
        assertEquals(429, thrown.status)
    }
}
