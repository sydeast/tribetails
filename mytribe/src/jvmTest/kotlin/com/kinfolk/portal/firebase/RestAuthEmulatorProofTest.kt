package com.kinfolk.portal.firebase

import com.kinfolk.portal.auth.AuthRepository
import com.kinfolk.portal.auth.SignInFailureKind
import io.ktor.client.request.get
import io.ktor.client.request.headers
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.isSuccess
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Assume.assumeTrue
import java.security.MessageDigest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * #889 emulator proof: the JVM client's failed-login report and password
 * reset calls reach the Auth + Functions emulators, not production.
 *
 * Skipped unless FIREBASE_AUTH_EMULATOR_HOST, FUNCTIONS_EMULATOR_HOST and
 * FIRESTORE_EMULATOR_HOST are all set, the same assumeTrue gate
 * KinfolkMergeEmulatorTest (auntieos-admin) uses for FIRESTORE_EMULATOR_HOST
 * alone. Run it from mytribe/:
 *
 *   firebase emulators:exec --project auntieos-ttpc \
 *     --only auth,firestore,functions:mytribe:requestPasswordReset,functions:mytribe:recordFailedLogin \
 *     'FUNCTIONS_EMULATOR_HOST=127.0.0.1:5001 ./gradlew :jvmTest --no-daemon --rerun --tests "*RestAuthEmulatorProofTest"'
 *
 * emulators:exec sets FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST
 * itself. FUNCTIONS_EMULATOR_HOST is this client's own convention (#889, not a
 * firebase-tools variable), so it is exported manually alongside the command.
 * Firestore rides along (not named in the #889 write-up) because
 * requestPasswordReset and recordFailedLogin both read/write Firestore
 * (rate limits, the unknownLoginAttempts doc this test reads back) before
 * anything else; without a local Firestore emulator the Functions emulator
 * falls back to PRODUCTION Firestore for those calls, which is exactly what
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
        assumeTrue(
            "FIRESTORE_EMULATOR_HOST is not set; this test only runs against the emulator",
            !System.getenv("FIRESTORE_EMULATOR_HOST").isNullOrBlank(),
        )
    }

    /** Same hash scheme as functions/src/auth/loginSecurity.ts hashEmail: sha256(lower.trim()).hex.slice(0,32). */
    private fun hashEmail(email: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(email.lowercase().trim().toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) }.substring(0, 32)
    }

    /**
     * A wrong-password sign-in reaches the Auth emulator
     * (accounts:signInWithPassword), is classified as a credential failure
     * (not merely "some error", #889 review item 6), and reports it to the
     * Functions emulator's recordFailedLogin (#886's own wiring,
     * RestAuthBackend's default failedLoginReporter). The report runs on a
     * background scope, so this joins that scope's child job before
     * returning, or the emulator process could exit before the request
     * leaves. Then it reads back recordFailedLogin's own Firestore write
     * (unknownLoginAttempts/{hashEmail(email)}, since this email is not a
     * real account) with Bearer owner, test-only, to prove the side effect
     * itself landed on the emulator, not just that the HTTP call returned.
     */
    @Test
    fun aWrongPasswordSignInReportsTheFailureToTheFunctionsEmulator(): Unit = runBlocking {
        val email = "nobody-889-${System.nanoTime()}@example.test"
        val backend = RestAuthBackend()
        val reportScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val repo = AuthRepository(backend, reportScope = reportScope)

        val ex = assertFailsWith<FirebaseRestException> {
            repo.signInWithEmailPassword(email, "definitely-wrong-password")
        }
        assertEquals(
            SignInFailureKind.Credentials,
            backend.classifySignInFailure(ex),
            "expected a credential failure (the predicate that fires the report), got: ${ex.responseBody}",
        )
        val children = reportScope.coroutineContext[Job]?.children?.toList().orEmpty()
        for (child in children) child.join()

        val hash = hashEmail(email)
        val url = "${FirebaseRestConfig.firestoreBase()}/unknownLoginAttempts/$hash"
        val res = RestHttp.client.get(url) {
            headers { append(HttpHeaders.Authorization, "Bearer owner") }
        }
        check(res.status.isSuccess()) {
            "expected recordFailedLogin to have written unknownLoginAttempts/$hash on the emulator, " +
                "got ${res.status.value}: ${res.bodyAsText()}"
        }
        val fields = RestHttp.json.parseToJsonElement(res.bodyAsText()).jsonObject["fields"]?.jsonObject
        val attempts = fields?.get("attempts")?.jsonObject?.get("arrayValue")?.jsonObject?.get("values")?.jsonArray
        assertEquals(1, attempts?.size, "expected exactly one recorded attempt for a fresh, unique email")
    }

    /** requestPasswordReset always answers success (existence-oracle protection); reaching it is the proof. */
    @Test
    fun requestingAPasswordResetReachesTheFunctionsEmulator() = runBlocking {
        RestAuthClient().sendPasswordReset("nobody-889-${System.nanoTime()}@example.test")
    }
}
