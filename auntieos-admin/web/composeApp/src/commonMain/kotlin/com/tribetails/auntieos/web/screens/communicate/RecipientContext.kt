package com.tribetails.auntieos.web.screens.communicate

import com.tribetails.auntieos.web.data.Kinfolk

// ─────────────────────────────────────────────────────────────────────────────
// Recipient context: pure pre-flight for on-demand profile synthesis
// ("Refresh intelligence"). Decision logic lives here (not in the composable) so
// it is unit-tested on pure JVM in commonTest. The composable + FirestoreClient
// consume these. Mirrors the Android CommunicateViewModel.synthesizeProfile guard.
// ─────────────────────────────────────────────────────────────────────────────

/** Success line shown after a synthesis run. Mirrors the Android UX verbatim. */
const val SYNTHESIZE_SUCCESS = "Profile updated from recent history."

/**
 * Pre-flight for "Refresh intelligence". Synthesis sends the recipient's id to the
 * synthesize_kinfolk_profile callable, so a missing recipient (or one with no id)
 * must fail loud with a clear reason instead of silently no-op'ing. Returns the
 * fail-loud reason, or null when it is clear to run.
 */
fun synthesizeBlocker(recipient: Kinfolk?): String? =
    if (recipient?._id.isNullOrBlank()) "Pick a recipient before refreshing intelligence." else null

// ─────────────────────────────────────────────────────────────────────────────
// Pure render-mapping helpers for the dossier / kin "411" panel (mirrors the
// Android ContextPanel → DossierPanel / KinCard). Kept here, not in the
// composable, so the formatting + hide rules are unit-tested on pure JVM.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One-line "species · breed" meta shown under a kin's name in a KinCard. Each part
 * is trimmed, blank parts are dropped, and both-blank yields "". Mirrors the
 * Android KinCard, where species comes from the Kin doc and breed from its 411.
 */
fun kinMetaLine(species: String, breed: String): String =
    listOf(species.trim(), breed.trim())
        .filter { it.isNotEmpty() }
        .joinToString(" · ")

/**
 * Whether a dossier / 411 context field should render. Mirrors the Android
 * ContextField guard: a blank value or the reconcile placeholder "Not yet
 * documented." is hidden rather than drawn as an empty / filler row.
 */
fun contextFieldShown(value: String): Boolean =
    value.isNotBlank() && value.trim() != "Not yet documented."
