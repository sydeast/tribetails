package com.kinfolk.portal.firebase

import com.kinfolk.portal.auth.AuthRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertFailsWith

/**
 * #889 emulator proof: the JVM client's failed-login report and password
 * reset calls reach the Auth + Functions emulators, not production.
 *
 * Skipped unless both FIREBASE_AUTH_EMULATOR_HOST and FUNCTIONS_EMULATOR_HOST
 * are set — the same `assumeTrue` gate `KinfolkMergeEmulatorTest`
 * (auntieos-admin) uses for FIRESTORE_EMULATOR_HOST. Run it from `mytribe/`:
 *
 *   firebase emulators:exec --project auntieos-ttpc \
 *     --only auth,firestore,functions:mytribe:requestPasswordReset,functions:mytribe:recordFailedLogin \
 *     'FUNCTIONS_EMULATOR_HOST=127.0.0.1:5001 ./gradlew :jvmTest --no-daemon --rerun --tests "*RestAuthEmulatorProofTest"'
 *
 * `emulators:exec` sets FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST
 * itself. FUNCTIONS_EMULATOR_HOST is this client's own convention (#889, not a
 * firebase-tools variable), so it is exported manually alongside the command.
 * Firestore rides along (not named in the #889 write-up) because
 * `requestPasswordReset` reads/writes a Firestore rate-limit doc before
 * anything else; without a local Firestore emulator the Functions emulator
 * falls back to PRODUCTION Firestore for that call, which is exactly what
 * this whole issue exists to stop.
 */
class RestAuthEmulatorProofTest {

    @BeforeTest
    fun requireEmulators() {
        assumeTrue(
            "FIREBASE_AUTH_EMULATOR_HOST is not set; this test only runs against the emulator",
            !System.getenv("FIREBASE_AUTH_EMULATOR_HOST").isNullOrBlank(),
        )
        assumeTrue(
            "FUNCTIONS_EMULATOR_HOST is not set; this test only runs against the emulator",
            !System.getenv("FUNCTIONS_EMULATOR_HOST").isNullOrBlank(),
        )
    }

    /**
     * A wrong-password sign-in reaches the Auth emulator (accounts:signInWithPassword),
     * is classified as a credential failure, and reports it to the Functions
     * emulator's `recordFailedLogin` (#886's own wiring, RestAuthBackend's
     * default `failedLoginReporter`). The report runs on a background scope, so
     * this joins that scope's child job before returning, or the emulator
     * process could exit before the request leaves.
     */
    @Test
    fun aWrongPasswordSignInReportsTheFailureToTheFunctionsEmulator(): Unit = runBlocking {
        val reportScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val repo = AuthRepository(RestAuthBackend(), reportScope = reportScope)
        assertFailsWith<Throwable> {
            repo.signInWithEmailPassword("nobody-889@example.test", "definitely-wrong-password")
        }
        val children = reportScope.coroutineContext[Job]?.children?.toList().orEmpty()
        for (child in children) child.join()
    }

    /** requestPasswordReset always answers success (existence-oracle protection); reaching it is the proof. */
    @Test
    fun requestingAPasswordResetReachesTheFunctionsEmulator() = runBlocking {
        RestAuthClient().sendPasswordReset("nobody-889@example.test")
    }
}
