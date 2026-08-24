package com.kinfolk.portal.attestation

import android.util.Log
import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory
import com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory
import io.sentry.Sentry

private const val TAG = "AppCheck"

/**
 * App Check for the portal Android app (`com.kinfolk.portal`).
 *
 * Play Integrity, per the O-3 ruling's D1. NOT SafetyNet, which is decommissioned,
 * and no fallback to it. Debug builds install the debug provider instead and the
 * developer registers that token in the Firebase console; a debug provider in a
 * release build would attest nothing, which is worse than not attesting at all
 * because it looks like it works.
 *
 * WHY THIS EXISTS AT ALL. Issue #556 was filed about the web portal's App Check
 * guard being permanently true. Reading the Android client for the same defect
 * class turned up something plainer: there was no App Check here whatever, no
 * dependency and no call, while the ruling had it as Phase 2 and the backend
 * wrapper had been logging `appCheck: "absent"` for every Android request since
 * L1 shipped. The web bug hid an inert feature; the Android gap hid a missing one.
 *
 * There is no reCAPTCHA ordering hazard on this surface. That whole problem is a
 * browser problem — two Firebase streams fighting over `window.grecaptcha` — and
 * the native SDK has no such shared global, which is why this activates flatly at
 * process start instead of waiting for an auth state the way `web/src/lib/boot.ts`
 * has to.
 */
val appCheckState = AppCheckState { reason, error ->
    // Loud in logcat AND in Sentry. An Android build that silently stopped
    // attesting would show up nowhere else until enforcement refused it.
    Log.e(TAG, "$reason. Callables from this process are unattested.", error)
    try {
        Sentry.captureException(error ?: IllegalStateException(reason))
    } catch (_: Throwable) {
        // A reporter must never be the thing that crashes the app.
    }
}

/**
 * Install the provider and prove it works by fetching one token.
 *
 * The install call returning is not evidence of anything: every real failure
 * (app not registered in the App Check console, Play Integrity unavailable on
 * the device, an unregistered debug token) surfaces later, inside a token
 * fetch. So we ask for one immediately rather than waiting to find out from a
 * refused callable.
 *
 * Never throws. An attestation problem must not be able to stop the app
 * launching, and it cannot lock anyone out either: App Check is not this
 * system's authorization boundary — `req.auth` claims and firestore.rules are —
 * and the backend gate defaults to log-only (functions/src/lib/appCheckPolicy.ts).
 *
 * @param useDebugProvider true for a debuggable build.
 */
fun activateAppCheck(useDebugProvider: Boolean) {
    if (!appCheckState.beginActivation()) return
    try {
        val appCheck = FirebaseAppCheck.getInstance()
        appCheck.installAppCheckProviderFactory(
            if (useDebugProvider) {
                DebugAppCheckProviderFactory.getInstance()
            } else {
                PlayIntegrityAppCheckProviderFactory.getInstance()
            },
        )
        appCheck.getAppCheckToken(false)
            .addOnSuccessListener {
                appCheckState.attested()
                Log.i(TAG, "attestation active")
            }
            .addOnFailureListener { error ->
                appCheckState.failed("attestation failed", error)
            }
    } catch (t: Throwable) {
        appCheckState.failed("installAppCheckProviderFactory threw", t)
    }
}
