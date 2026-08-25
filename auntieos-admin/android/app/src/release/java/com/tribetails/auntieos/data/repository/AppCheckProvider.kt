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
 * Play Integrity requires the app registered in the Play Console, and this app
 * will never be: the owner ruled OWNER-1 a hard, permanent "no public store,
 * APK-sideload only" (`mytribe/docs/DEVELOPMENT_PLAN_2026-07-10.md`,
 * 2026-07-14/15 session). Verified against the live project on 2026-08-24:
 * `com.tribetails.auntieos` has no `playIntegrityConfig`, and none is coming,
 * so token fetches fail permanently and `AppCheckActivation.status` reports
 * `Failed` out loud on every launch. Nothing breaks, because the backend
 * policy ships in `log` mode and App Check is not this system's authorization
 * boundary. Actually attesting from a sideloaded APK needs a different
 * mechanism entirely (the non-Play path `O3_APP_CHECK_RULING_2026-07-13.md`
 * re-scopes Phase 2 to), not an operator console click.
 */
internal fun installAppCheckProvider() {
    FirebaseAppCheck.getInstance()
        .installAppCheckProviderFactory(PlayIntegrityAppCheckProviderFactory.getInstance())
}
