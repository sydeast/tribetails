package com.kinfolk.portal.auth

import com.kinfolk.portal.firebase.RestEndpoints
import com.kinfolk.portal.firebase.RestHttp
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.OutgoingContent
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse

/**
 * #889 review, item 1 and item 5: JvmSecureResetFetcher used to build its own
 * HttpClient(CIO) and always post to the hardcoded production base. This
 * pins the fix: an explicit base (the DEFAULT_SECURE_RESET_BASE the caller
 * passes) is used when no emulator is configured, and
 * FirebaseRestConfig.functionsBase() takes over when one is.
 */
class SecureResetFetcherUrlTest {

    private val prodBase = "https://us-central1-auntieos-ttpc.cloudfunctions.net"

    private fun endpoints(emulator: Boolean) = RestEndpoints(
        env = { if (emulator && it == "FUNCTIONS_EMULATOR_HOST") "127.0.0.1:5001" else null },
    )

    private fun clientCapturing(seenUrls: MutableList<String>) =
        RestHttp.buildClient(MockEngine, guardRequests = false) {
            engine {
                addHandler { request ->
                    seenUrls += request.url.toString()
                    respond(
                        content = """{"incidentId":"inc1"}""",
                        status = HttpStatusCode.OK,
                        headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
                    )
                }
            }
        }

    @Test
    fun confirmResetHitsTheFunctionsEmulatorWhenConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        val fetcher = JvmSecureResetFetcher(prodBase, clientCapturing(urls), endpoints(emulator = true))
        fetcher.confirmReset("oob1", "newpass123", "a@b.com", "ua")
        assertEquals("http://127.0.0.1:5001/auntieos-ttpc/us-central1/confirmSecureReset", urls.single())
    }

    @Test
    fun confirmResetHitsTheExplicitProdBaseWhenNoEmulatorIsConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        val fetcher = JvmSecureResetFetcher(prodBase, clientCapturing(urls), endpoints(emulator = false))
        fetcher.confirmReset("oob1", "newpass123", "a@b.com", "ua")
        assertEquals("$prodBase/confirmSecureReset", urls.single())
    }

    /**
     * #889 review round 3, item 3: this call carries the new password.
     * Gating on emulatorActive (any of the three switches) instead of the
     * Functions emulator specifically meant that setting only
     * FIRESTORE_EMULATOR_HOST, with a GCLOUD_PROJECT=demo-x override
     * alongside it, sent the password to a Functions emulator host that was
     * never actually configured. It must stay on the explicit prod base.
     *
     * Uses a distinctive custom base, not the literal cloudfunctions.net
     * string: functionsBase()'s own production branch now always carries the
     * real project id too (a separate fix), so routing through it would
     * often produce the SAME url as the real prod default and hide a
     * regression in this gate specifically. A custom base makes the two
     * fixes distinguishable.
     */
    @Test
    fun confirmResetStaysOnTheExplicitProdBaseWhenOnlyFirestoreEmulatorIsConfigured() = runBlocking {
        val urls = mutableListOf<String>()
        val customBase = "https://custom-secure-reset-base.example"
        val endpoints = RestEndpoints(
            env = {
                when (it) {
                    "FIRESTORE_EMULATOR_HOST" -> "127.0.0.1:8080"
                    "GCLOUD_PROJECT" -> "demo-x"
                    else -> null
                }
            },
        )
        val fetcher = JvmSecureResetFetcher(customBase, clientCapturing(urls), endpoints)
        fetcher.confirmReset("oob1", "newpass123", "a@b.com", "ua")
        assertEquals("$customBase/confirmSecureReset", urls.single())
    }

    /**
     * #933 item 4: the desktop body is [secureResetPayload], the same three
     * keys Android and web post. It used to add an `email` field, which the
     * server has ignored since #903.
     */
    @Test
    fun confirmResetPostsTheSharedPayloadAndNoEmail() = runBlocking {
        val bodies = mutableListOf<String>()
        val client = RestHttp.buildClient(MockEngine, guardRequests = false) {
            engine {
                addHandler { request ->
                    bodies += (request.body as OutgoingContent.ByteArrayContent).bytes().decodeToString()
                    respond(
                        content = """{"incidentId":"inc1"}""",
                        status = HttpStatusCode.OK,
                        headers = headersOf(HttpHeaders.ContentType, ContentType.Application.Json.toString()),
                    )
                }
            }
        }
        val fetcher = JvmSecureResetFetcher(prodBase, client, endpoints(emulator = false))
        fetcher.confirmReset("oob1", "newpass123", "pat@household.test", "ua")
        assertEquals(secureResetPayload("oob1", "newpass123", "ua"), bodies.single())
        assertFalse("email" in bodies.single(), "the desktop body must name no account, got ${bodies.single()}")
        assertFalse("pat@household.test" in bodies.single())
    }
}
