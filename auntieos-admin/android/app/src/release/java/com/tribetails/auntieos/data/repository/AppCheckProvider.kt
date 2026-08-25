package com.tribetails.auntieos.data.repository

import com.google.firebase.appcheck.FirebaseAppCheck
import com.google.firebase.appcheck.playintegrity.PlayIntegrityAppCheckProviderFactory

/**
 * The RELEASE half of the App Check provider choice (#576).
 *
 * Play Integrity, and nothing else. O-3 D1 is explicit that SafetyNet is
 * decommissioned: do not implement it, and do not add a fallback to it — a
 * fallback to a dead attestation is worse than none, because it reads as
 * coverage.
 *
 * Play Integrity requires the app registered in the Play Console. Verified
 * against the live project on 2026-08-24: `com.tribetails.auntieos` has no
 * `playIntegrityConfig` yet, so until an operator registers it, token fetches
 * fail and `AppCheckActivation.status` reports `Failed` out loud. Nothing
 * breaks, because the backend policy ships in `log` mode and App Check is not
 * this system's authorization boundary.
 */
internal fun installAppCheckProvider() {
    FirebaseAppCheck.getInstance()
        .installAppCheckProviderFactory(PlayIntegrityAppCheckProviderFactory.getInstance())
}
