package com.kinfolk.portal.firebase

import io.ktor.client.request.get
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #889: RestHttp refuses any request to a non-emulator host while :jvmTest is
 * running. `mytribe/build.gradle.kts` sets -Dkinfolk.portal.testRuntime=true
 * on exactly that Gradle Test task, so the guard is live for every class in
 * this suite, this one included — no per-class opt-in needed.
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

    @Test
    fun allowsLoopbackAndConfiguredEmulatorHosts() {
        assertTrue(RestHttp.isAllowedTestHost("localhost"))
        assertTrue(RestHttp.isAllowedTestHost("127.0.0.1"))
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
     * just the pure predicate above. The guard runs in Ktor's request pipeline
     * before the CIO engine opens a connection, so this never reaches the
     * network — if it did, this test would be the one real-network call this
     * whole issue exists to prevent.
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
}
