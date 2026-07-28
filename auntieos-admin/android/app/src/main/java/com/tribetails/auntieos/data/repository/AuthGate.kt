package com.tribetails.auntieos.data.repository

import com.google.firebase.auth.FirebaseAuth
import com.tribetails.auntieos.domain.TestMode
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.tasks.await

/**
 * W4-2: the shared auth seam every domain repo sits behind. It answers the two
 * questions a repo asks before it touches Firebase, and answers them in ONE
 * place:
 *
 *  - Is an admin signed in? [ensureAuthenticated] throws the single user-facing
 *    sentence the app shows for a signed-out call, instead of letting a raw
 *    Firebase permission error reach the screen.
 *  - Which sandbox is that admin confined to? [testMode] reads the `testTribeId`
 *    custom claim off the ID token and CACHES it, so per-query scoping does not
 *    re-fetch a token on every read.
 *
 * WHY A SEAM RATHER THAN A COPY. W4-1 carved the first domain repo out of the
 * `AuntieRepository` god-file and paid for it twice: the four-line sign-in gate
 * was copied verbatim into [InvoiceRepository], and the god-file's
 * `requireTestMode` was widened to internal so the new repo could borrow its
 * claim cache. That is one duplicate and one reach-back today, with about nine
 * domains still to carve (CONTEXT.md "Domain repos"). The choice was between
 * fixing it once here and repeating it nine more times.
 *
 * BOUNDARY AGAINST [ScopedFirestore]. This gate is the SOURCE of [TestMode];
 * [ScopedFirestore] is a CONSUMER of it. The gate knows nothing about queries,
 * collections, or scoping shapes; the ScopedFirestore seam knows nothing about
 * tokens, claims, or sign-in. A repo wires them one way only, as
 * `ScopedFirestore(firestore, authGate::requireTestMode)`, so neither seam can
 * grow into the other. Decision logic (claim to [TestMode], the scope
 * selectors) stays where it already is, in the pure domain [TestMode]. What
 * lives here is the CLAIM PLUMBING: reading it, caching it, failing loud when
 * it cannot be read.
 *
 * This is NOT the Auth domain repo. That carve owns the operator-facing flows
 * (sign-in, sign-out, password reset, login-email change, the `admin` claim),
 * which still sit in [AuntieRepository] and which will consume this gate like
 * every other repo does.
 *
 * @param authProvider the [FirebaseAuth] source, resolved lazily so merely
 *   constructing a gate (or a repo that defaults to [shared]) never touches a
 *   Firebase singleton. Tests pass their own.
 */
class AuthGate(
    authProvider: () -> FirebaseAuth = { FirebaseAuth.getInstance() },
) {
    private val auth: FirebaseAuth by lazy(authProvider)

    @Volatile
    private var cachedTestMode: TestMode? = null

    /**
     * The sign-in gate. Fails with the sentence the operator actually reads, so
     * a signed-out call fails identically no matter which repo it came from.
     * That sentence is user-facing and now has exactly one definition.
     */
    fun ensureAuthenticated() {
        if (auth.currentUser == null) {
            throw IllegalStateException("Admin sign-in required before using AuntieOS.")
        }
    }

    /**
     * Reads the `testTribeId` custom claim from the current user's ID token and
     * returns [TestMode]. Forces a token refresh so a server-set claim is picked
     * up without an app restart (parity with `isCurrentUserAdmin`), then caches
     * the answer so the per-query scoping below it does not re-fetch a token on
     * every read. [forceRefresh] re-reads.
     *
     * THE ONLY PLACE THIS CLAIM IS READ. Every domain repo resolves its mode
     * through this instance, so a signed-in session costs one token read rather
     * than one per repo, and a stale claim cannot be live in one repo and fresh
     * in another. A failed read caches nothing and surfaces via Result.failure.
     */
    suspend fun testMode(forceRefresh: Boolean = false): Result<TestMode> = runCatching {
        ensureAuthenticated()
        cachedTestMode?.let { if (!forceRefresh) return@runCatching it }
        val token = auth.currentUser?.getIdToken(true)?.await()
        val mode = TestMode.fromClaims(token?.claims)
        AuntieLog.d("getTestMode uid=${auth.currentUser?.uid} active=${mode.active} tribe=${mode.testTribeId}")
        cachedTestMode = mode
        mode
    }.onFailure { AuntieLog.e("Failed to read testTribeId claim", it) }

    /**
     * Resolve the active TestMode for an in-flight scoped read. Throws, rather
     * than silently treating the caller as a normal admin, when the claim cannot
     * be read: a denied or failed claim check must fail loud instead of leaking
     * a broad unscoped query that Firestore rules would reject anyway.
     */
    suspend fun requireTestMode(): TestMode =
        testMode().getOrElse {
            throw IllegalStateException("Could not resolve test-mode claim before a scoped read", it)
        }

    /** Clears the cached claim so the next account re-reads its own. Sign-out calls this. */
    fun clearTestModeCache() {
        cachedTestMode = null
    }

    companion object {
        /**
         * The process-wide gate, and the constructor default of every repo that
         * takes one. ONE INSTANCE BECAUSE ONE CACHE: a second gate would mean a
         * second claim cache, a second token read per signed-in session, and two
         * places a stale `testTribeId` could survive a sign-out. Constructing it
         * touches no Firebase singleton, so naming it as a default argument is
         * safe in a Firebase-less unit test; tests that want their own state
         * pass their own gate.
         */
        val shared: AuthGate = AuthGate()
    }
}
