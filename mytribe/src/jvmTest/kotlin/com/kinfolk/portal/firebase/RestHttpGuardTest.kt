package com.kinfolk.portal.firebase

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.get
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
 * #889: RestHttp refuses any request to a non-loopback, non-private host
 * while :jvmTest is running. mytribe/build.gradle.kts sets
 * -Dkinfolk.portal.testRuntime=true on exactly that Gradle Test task, so the
 * guard is live for every class in this suite, this one included, no
 * per-class opt-in needed.
 */
class RestHttpGuardTest {

    @Test
    fun theSharedTestSetupArmedTheGuardForThisRun() {
        // If this fails, the whole point of this file is untested: every
        // other assertion here would be exercising dead code.
        assertEquals(
            "true",
            System.getProperty("kinfolk.portal.testRuntime"),
            "build.gradle.kts should set this system property on the jvmTest task",
        )
    }

    /** #889 review, item 9: renamed from allowsLoopbackAndConfiguredEmulatorHosts, the old
     *  name described a guard that trusted an env var's raw value; it no longer does (item 4). */
    @Test
    fun allowsLoopbackAndPrivateHosts() {
        assertTrue(RestHttp.isAllowedTestHost("localhost"))
        assertTrue(RestHttp.isAllowedTestHost("127.0.0.1"))
        assertTrue(RestHttp.isAllowedTestHost("::1"))
        assertTrue(RestHttp.isAllowedTestHost("10.0.0.1"))
        assertTrue(RestHttp.isAllowedTestHost("172.16.0.1"))
        assertTrue(RestHttp.isAllowedTestHost("172.31.255.255"))
        assertTrue(RestHttp.isAllowedTestHost("192.168.1.1"))
        assertTrue(RestHttp.isAllowedTestHost("fc00::1"))
    }

    @Test
    fun rejectsJustOutsideThePrivateRangesAndPublicHosts() {
        assertFalse(RestHttp.isAllowedTestHost("172.15.255.255"))
        assertFalse(RestHttp.isAllowedTestHost("172.32.0.0"))
        assertFalse(RestHttp.isAllowedTestHost("0.0.0.0"))
        assertFalse(RestHttp.isAllowedTestHost("8.8.8.8"))
    }

    @Test
    fun refusesRealFirebaseHosts() {
        assertFalse(RestHttp.isAllowedTestHost("identitytoolkit.googleapis.com"))
        assertFalse(RestHttp.isAllowedTestHost("securetoken.googleapis.com"))
        assertFalse(RestHttp.isAllowedTestHost("firestore.googleapis.com"))
        assertFalse(RestHttp.isAllowedTestHost("us-central1-auntieos-ttpc.cloudfunctions.net"))
    }

    /**
     * The end-to-end proof: a real request through the shared client, not
     * just the pure predicate above. The guard runs in Ktor's request
     * pipeline before the CIO engine opens a connection, so this never
     * reaches the network; if it did, this test would be the one
     * real-network call this whole issue exists to prevent.
     */
    @Test
    fun theLiveClientThrowsBeforeReachingAProductionHost() = runBlocking {
        val ex = assertFailsWith<IllegalStateException> {
            RestHttp.client.get("https://firestore.googleapis.com/v1/projects/nope/databases/(default)/documents/x")
        }
        assertTrue(
            ex.message.orEmpty().contains("firestore.googleapis.com"),
            "expected the guard's message to name the refused host, got: ${ex.message}",
        )
    }

    /**
     * #889 review, item 7: the guard used to run only as an onRequest hook,
     * so a 3xx response from an allowed host could redirect anywhere and the
     * guard would never see the second hop. It is now an HttpSend
     * interceptor installed after the client is built, which sits inside
     * Ktor's own redirect-following interceptor and therefore fires again
     * for every hop. This proves it: a loopback mock answers with a redirect
     * to a `.invalid` host, and the mock must never receive that second
     * request.
     */
    @Test
    fun theGuardFiresOnEveryRedirectHopNotJustTheFirst() = runBlocking {
        val seenHosts = mutableListOf<String>()
        val client = RestHttp.buildClient(MockEngine, guardRequests = true) {
            engine {
                addHandler { request ->
                    seenHosts += request.url.host
                    if (request.url.host == "127.0.0.1") {
                        respond(
                            content = "",
                            status = HttpStatusCode.Found,
                            headers = headersOf(HttpHeaders.Location, "http://guard-bypass.invalid/x"),
                        )
                    } else {
                        respond(content = "should never be reached", status = HttpStatusCode.OK)
                    }
                }
            }
        }
        val ex = assertFailsWith<IllegalStateException> {
            client.get("http://127.0.0.1:9099/start")
        }
        assertTrue(
            ex.message.orEmpty().contains("guard-bypass.invalid"),
            "expected the guard to name the redirect target, got: ${ex.message}",
        )
        assertEquals(
            listOf("127.0.0.1"),
            seenHosts,
            "the redirect target must never reach the engine: the guard should have stopped it first",
        )
    }
}
