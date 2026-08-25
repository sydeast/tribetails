package com.tribetails.auntieos.data.repository

import com.google.firebase.appcheck.FirebaseAppCheck
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.tasks.await

/**
 * O-3 App Check, Android admin client half (issue #576).
 *
 * The backend policy layer shipped in #562
 * (`MyTribe/functions/src/lib/appCheckPolicy.ts`): a cohort list in code, a mode
 * read from `business_settings/security.appCheckMode` (off | log | enforce,
 * default log, fails open), and telemetry that tells an INVALID attestation
 * apart from an ABSENT one. Until this file existed, every request this app made
 * was `absent`.
 *
 * ---------------------------------------------------------------------------
 * PLAY INTEGRITY, NOT SAFETYNET
 * ---------------------------------------------------------------------------
 * O-3 D1 is explicit: SafetyNet is decommissioned, so do not implement it and do
 * not fall back to it. Debug builds use the debug provider instead, whose token
 * each developer registers once in the App Check console.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS APP CAN NEVER REGISTER FOR PLAY INTEGRITY
 * ---------------------------------------------------------------------------
 * Checked against the live project on 2026-08-24 rather than assumed:
 * `firebaseappcheck.googleapis.com/.../apps/1:153396971788:android:6bcb7c5411aeda837f2129/playIntegrityConfig`
 * comes back empty, so `com.tribetails.auntieos` has no Play Integrity
 * registration (nor does the kinfolk portal's `com.kinfolk.portal`, issue #576's
 * matching item). This is not a pending task: the owner ruled OWNER-1 in
 * `mytribe/docs/DEVELOPMENT_PLAN_2026-07-10.md` (2026-07-14/15 session) a hard
 * "NO — permanent. The app will never be in a public store. Android stays
 * APK-sideload only... Never present Play Console registration as an option
 * again." Play Integrity requires the app registered in the Play Console (an
 * internal-testing-track upload would even suffice), and that will not happen.
 * So this app cannot attest via Play Integrity, ever, absent a future non-Play
 * attestation path (`O3_APP_CHECK_RULING_2026-07-13.md`'s re-scoped Phase 2,
 * not yet built).
 *
 * Shipping the Play Integrity provider anyway is still the correct call and not
 * a gamble, because App Check is not an authorization boundary: `req.auth`
 * claims and firestore.rules are, and the policy layer ships in `log` mode
 * where nothing is refused. So the permanently-unregistered state costs one
 * failed token fetch per launch, which this file reports as
 * [AppCheckStatus.Failed] — loudly, in the log and in Sentry — rather than
 * swallowing. That keeps the gap visible instead of inventing a fake pass, the
 * same failure mode that let the kinfolk portal spend months believing it had
 * attestation it had never once obtained (#556).
 */
enum class AppCheckStatus {
    /** Never attempted. Only ever true before [AppCheckActivation.activate] runs. */
    Inactive,

    /** Skipped on purpose: a Robolectric run has no Play Services to attest with. */
    Unsupported,

    /** Activated; the first token has not come back yet. */
    Pending,

    /** A real App Check token was minted in this process. */
    Active,

    /** Activation threw, or the first token could not be obtained. */
    Failed,
}

/**
 * What actually happened, as a value anything can read.
 *
 * [AppCheckStatus.Failed] exists SEPARATELY from [AppCheckStatus.Inactive] on
 * purpose: a broken attestation must never read the same as one that was
 * deliberately skipped. The portal had no way to tell those apart before #556,
 * which is a large part of why nobody noticed App Check had never activated
 * there at all.
 */
object AppCheckActivation {

    @Volatile
    var status: AppCheckStatus = AppCheckStatus.Inactive
        private set

    /** Test seam. Nothing in `src/main` calls this. */
    internal fun resetForTest() {
        status = AppCheckStatus.Inactive
    }

    /**
     * Install the provider. Called once from `AuntieOSApp.onCreate`, before any
     * repository can fire a callable, so the very first request of the process
     * either carries a token or is already recorded as unattested.
     *
     * WHICH PROVIDER is not decided here. `installAppCheckProvider()` has one
     * body in `src/debug` and another in `src/release`, so a release APK does
     * not merely decline to use the debug provider — it does not contain it.
     * A boolean would have left the debug factory on the release classpath,
     * one wrong branch away from accepting a developer's debug token in
     * production.
     *
     * @param isRobolectric skip entirely. A JVM test has no Play Services, and
     *   the resulting failure would be noise that trains people to ignore the
     *   one line this file exists to print.
     * @param install seam for the unit tests, which have no `FirebaseApp`.
     */
    fun activate(
        isRobolectric: Boolean,
        install: () -> Unit = ::installAppCheckProvider,
    ) {
        if (status != AppCheckStatus.Inactive) return
        if (isRobolectric) {
            status = AppCheckStatus.Unsupported
            return
        }
        try {
            install()
        } catch (t: Throwable) {
            failed("installAppCheckProviderFactory threw", t)
            return
        }
        status = AppCheckStatus.Pending
    }

    /**
     * Fetch one token, so activation means something.
     *
     * Installing a provider factory returns immediately and proves nothing: an
     * unregistered app, a device without Play Services, a Play Integrity API
     * that is not enabled — every real failure shows up later, inside a token
     * fetch nobody was watching. Called from `AuntieOSApp`'s scope so it never
     * blocks cold start.
     */
    suspend fun probe(
        fetchToken: suspend () -> String = ::fetchAppCheckToken,
    ) {
        if (status != AppCheckStatus.Pending) return
        try {
            val token = fetchToken()
            if (token.isBlank()) {
                failed("App Check returned an empty token", IllegalStateException("empty token"))
                return
            }
            status = AppCheckStatus.Active
            AuntieLog.i("[AppCheck] attestation active")
        } catch (t: Throwable) {
            failed("attestation failed", t)
        }
    }

    private fun failed(reason: String, t: Throwable) {
        status = AppCheckStatus.Failed
        // Loud, in the log AND in Sentry. A silent pass here is the whole defect
        // class #556 and #576 are about.
        AuntieLog.e("[AppCheck] $reason. Callables from this process are unattested.", t)
        runCatching { io.sentry.Sentry.captureException(t) }
    }
}


private suspend fun fetchAppCheckToken(): String =
    FirebaseAppCheck.getInstance().getAppCheckToken(false).await().token
