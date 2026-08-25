package com.tribetails.auntieos.data.repository

import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.debug.DebugAppCheckProviderFactory

/**
 * The DEBUG half of the App Check provider choice (#576).
 *
 * O-3 D3: debug builds attest with the debug provider, whose token each
 * developer registers once in the Firebase App Check console. The token is
 * printed to logcat on first launch.
 *
 * This lives in `src/debug` rather than behind a `BuildConfig.DEBUG` branch so
 * the release APK does not merely decline to use the debug provider — it does
 * not contain it. A branch would leave the debug factory on the release
 * classpath, one mistake away from a production build accepting a developer's
 * debug token, and App Check exists precisely to make that impossible.
 */
internal fun installAppCheckProvider() {
    FirebaseAppCheck.getInstance()
        .installAppCheckProviderFactory(DebugAppCheckProviderFactory.getInstance())
}
