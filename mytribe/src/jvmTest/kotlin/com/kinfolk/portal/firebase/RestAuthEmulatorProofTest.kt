package com.kinfolk.portal.firebase

import com.kinfolk.portal.auth.AuthRepository
import com.kinfolk.portal.auth.SignInFailureKind
import io.ktor.client.request.get
import io.ktor.client.request.headers
import io.ktor.client.request.patch
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
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
 *     --only auth,firestore,functions:mytribe:recordFailedLogin,functions:mytribe:beforeSignIn,functions:mytribe:requestPasswordReset,functions:mytribe:onPasswordResetRequestCreate \
 *     'FUNCTIONS_EMULATOR_HOST=127.0.0.1:5001 ./gradlew :jvmTest --no-daemon --rerun --tests "*RestAuthEmulatorProofTest"'
 *
 * emulators:exec sets FIREBASE_AUTH_EMULATOR_HOST and FIRESTORE_EMULATOR_HOST
 * itself. FUNCTIONS_EMULATOR_HOST is this client's own convention (#889, not a
 * firebase-tools variable), so it is exported manually alongside the command.
 * Firestore rides along (not named in the #889 write-up) because
 * recordFailedLogin reads and writes Firestore (rate limits, the
 * unknownLoginAttempts doc this test reads back) before anything else; without
 * a local Firestore emulator the Functions emulator falls back to PRODUCTION
 * Firestore for those calls, which is exactly what this whole issue exists to
 * stop.
 *
 * #905: the reset half goes through Functions again. The client posts the
 * `requestPasswordReset` callable; the callable writes a
 * `passwordResetRequests` doc and answers; `onPasswordResetRequestCreate`
 * (the Firestore trigger, so it needs the Firestore emulator too) mints the
 * link with the Admin SDK against the Auth emulator, which keeps the code it
 * minted. The proof reads that code back out of the emulator's own oobCodes
 * endpoint, polling, because the trigger runs after the callable has already
 * answered. The trigger then tries smtp2go; with no SMTP2GO_API_KEY on the
 * emulator that send fails AFTER the link is minted, which is what this reads,
 * so no email leaves the machine. Both functions exist from PR #952 on; this
 * proof is not meant to pass against an older functions build.
 *
 * `beforeSignIn` joins the --only list for the locked-account test, which
 * needs a real refusal to prove the reset clears it.
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

    /**
     * #905: the desktop reset reaches the Functions emulator's
     * `requestPasswordReset`, and the server mints a real reset link for the
     * account that continues to the portal sign-in.
     *
     * The callable answers `{ ok: true }` for every address, so reaching it
     * proves little on its own. The link the trigger mints is the evidence:
     * sign an account up, send, then wait for the code to appear and check
     * what it is and where it continues.
     */
    @Test
    fun aPasswordResetReachesTheFunctionsEmulatorAndMintsAPortalResetLink(): Unit = runBlocking {
        val email = "nobody-905-${System.nanoTime()}@example.test"
        signUp(email, "starting-password-905")

        RestAuthClient().sendPasswordReset(email)

        val code = awaitResetCode(email)
        assertEquals("PASSWORD_RESET", code.requestType, "expected a reset code, got ${code.requestType}")
        check(code.oobLink.contains("continueUrl=https%3A%2F%2Fkinfolk.tribetails.com%2Fsignin")) {
            "expected the link to continue to the portal sign-in, got ${code.oobLink}"
        }
        println("905 reset link: ${code.oobLink}")
    }

    /**
     * #886, on #905's send path: a locked account is still unlockable by a
     * reset link the callable asked for.
     *
     * `beforeSignIn` clears a lock when Firebase Auth's `tokensValidAfterTime`
     * rises above the recorded lock start, and every password reset raises it,
     * so the send mechanism does not matter to the unlock. This proves that on
     * the callable path (which also exempts a locked account from the daily
     * cap): write a live lock onto the account's security doc, confirm sign-in
     * is refused, send through [RestAuthClient.sendPasswordReset], use the link
     * the trigger minted, then sign in and read the lock fields back.
     *
     * The refusal half needs `functions:mytribe:beforeSignIn` served. Without
     * it the locked sign-in simply succeeds, and this fails saying so rather
     * than passing quietly: a proof that cannot see the lock is not a proof.
     *
     * The two waits are load bearing. `tokensValidAfterTime` is a timestamp
     * with one-second resolution, and creating the account sets it. A lock that
     * started before the account was created reads as already cleared by a
     * reset, and a reset inside the same second as the lock start does not
     * clearly beat it. So: create, wait, start the lock, and reset a second
     * later again.
     */
    @Test
    fun aCallableResetUnlocksALockedAccount(): Unit = runBlocking {
        val email = "locked-905-${System.nanoTime()}@example.test"
        val startingPassword = "starting-password-905"
        val uid = signUp(email, startingPassword)

        delay(1_500)
        val nowMs = System.currentTimeMillis()
        writeLoginAttempts(
            uid,
            """{"fields":{"attempts":{"arrayValue":{"values":[]}},""" +
                """"lockedUntilMs":{"integerValue":"${nowMs + 30 * 60_000L}"},""" +
                """"lockStartedAtMs":{"integerValue":"$nowMs"},""" +
                """"updatedAtMs":{"integerValue":"$nowMs"}}}""",
        )

        val locked = signIn(email, startingPassword)
        println("905 locked sign-in: ${locked.first} ${locked.second}")
        check(locked.first != 200) {
            "beforeSignIn did not refuse the locked account; serve functions:mytribe:beforeSignIn for this test"
        }

        delay(1_500)
        RestAuthClient().sendPasswordReset(email)
        val code = awaitResetCode(email)
        println("905 locked-account reset link: ${code.oobLink}")

        val newPassword = "unlocked-by-callable-reset-905"
        val reset = RestHttp.client.post(
            "${FirebaseRestConfig.identityToolkitBase()}/accounts:resetPassword?key=${FirebaseRestConfig.API_KEY}",
        ) {
            contentType(ContentType.Application.Json)
            setBody("""{"oobCode":"${code.oobCode}","newPassword":"$newPassword"}""")
        }
        check(reset.status.isSuccess()) { "resetPassword failed: ${reset.status} ${reset.bodyAsText()}" }

        val after = signIn(email, newPassword)
        println("905 post-reset sign-in: ${after.first}")
        check(after.first == 200) { "expected the reset to clear the lock, got ${after.first}: ${after.second}" }

        val doc = RestHttp.client.get("${FirebaseRestConfig.firestoreBase()}/clients/$uid/security/loginAttempts") {
            headers { append(HttpHeaders.Authorization, "Bearer owner") }
        }
        val body = doc.bodyAsText()
        println("905 loginAttempts after: $body")
        check(!body.contains("lockedUntilMs")) { "expected beforeSignIn to have cleared lockedUntilMs, got $body" }
    }

    /** Creates an account on the Auth emulator and returns its uid. */
    private suspend fun signUp(email: String, password: String): String {
        val res = RestHttp.client.post(
            "${FirebaseRestConfig.identityToolkitBase()}/accounts:signUp?key=${FirebaseRestConfig.API_KEY}",
        ) {
            contentType(ContentType.Application.Json)
            setBody("""{"email":"$email","password":"$password","returnSecureToken":true}""")
        }
        check(res.status.isSuccess()) { "signUp failed: ${res.status} ${res.bodyAsText()}" }
        return RestHttp.json.parseToJsonElement(res.bodyAsText()).jsonObject["localId"]!!.jsonPrimitive.content
    }

    /** Signs in over REST. Returns the status code and the body, so a refusal can be printed. */
    private suspend fun signIn(email: String, password: String): Pair<Int, String> {
        val res = RestHttp.client.post(
            "${FirebaseRestConfig.identityToolkitBase()}/accounts:signInWithPassword?key=${FirebaseRestConfig.API_KEY}",
        ) {
            contentType(ContentType.Application.Json)
            setBody("""{"email":"$email","password":"$password","returnSecureToken":true}""")
        }
        return res.status.value to res.bodyAsText()
    }

    private data class OobCode(val email: String, val oobCode: String, val oobLink: String, val requestType: String)

    /**
     * The newest reset code for [email], waiting up to 30 seconds for it: the
     * trigger that mints it runs after the callable has answered.
     */
    private suspend fun awaitResetCode(email: String): OobCode {
        val deadline = System.currentTimeMillis() + 30_000
        while (true) {
            oobCodes().lastOrNull { it.email == email && it.requestType == "PASSWORD_RESET" }?.let { return it }
            check(System.currentTimeMillis() < deadline) {
                "no reset code for $email after 30s; is functions:mytribe:onPasswordResetRequestCreate served?"
            }
            delay(500)
        }
    }

    /** Every oob code the Auth emulator currently holds, oldest first. */
    private suspend fun oobCodes(): List<OobCode> {
        val host = System.getenv("FIREBASE_AUTH_EMULATOR_HOST")
        val res = RestHttp.client.get("http://$host/emulator/v1/projects/auntieos-ttpc/oobCodes")
        check(res.status.isSuccess()) { "oobCodes read failed: ${res.status} ${res.bodyAsText()}" }
        return RestHttp.json.parseToJsonElement(res.bodyAsText()).jsonObject["oobCodes"]!!.jsonArray.map {
            val o = it.jsonObject
            OobCode(
                email = o["email"]!!.jsonPrimitive.content,
                oobCode = o["oobCode"]!!.jsonPrimitive.content,
                oobLink = o["oobLink"]!!.jsonPrimitive.content,
                requestType = o["requestType"]!!.jsonPrimitive.content,
            )
        }
    }

    /** Writes the account's security doc straight onto the Firestore emulator, Bearer owner, test-only. */
    private suspend fun writeLoginAttempts(uid: String, documentJson: String) {
        val res = RestHttp.client.patch(
            "${FirebaseRestConfig.firestoreBase()}/clients/$uid/security/loginAttempts",
        ) {
            headers { append(HttpHeaders.Authorization, "Bearer owner") }
            contentType(ContentType.Application.Json)
            setBody(documentJson)
        }
        check(res.status.isSuccess()) { "loginAttempts write failed: ${res.status} ${res.bodyAsText()}" }
    }
}
