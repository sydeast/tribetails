package com.tribetails.auntieos.web.screens.sessions

import com.tribetails.auntieos.web.data.KinCareSession

/**
 * ISSUE #1608: the operator's "Verify arrival and departure" rule, checked on
 * the desktop console BEFORE Mark Completed is sent.
 *
 * The rule is the server's. `transitionBookingStatus` refuses COMPLETE with
 * `arrival_verification_required` when the switch is on and the session has no
 * `arrivedAt` or no `departedAt` (`mytribe/functions/src/lib/arrivalVerification.ts`).
 * This file mirrors that file's `missingVisitSteps` and
 * `arrivalVerificationMessage`, so the console says the same sentence without
 * the round trip. The server check stays; this is not the enforcement. The
 * twins are `auntieos-admin/src/lib/completeRule.ts` (web) and
 * `domain/CompleteRule.kt` (Android).
 *
 * ABSENT MEANS OFF, as on the server. [com.tribetails.auntieos.web.data.BusinessSettings]
 * defaults the field to `true` for the Settings editor, so the console reads
 * the raw document value (`FirestoreClient.arrivalRuleRequired`) instead.
 *
 * Steps only. The #582 distance gate stays on the server.
 */

/** Which of the two steps this visit is missing, in the order they happen. Blank counts as missing. */
internal fun missingVisitSteps(arrivedAt: String, departedAt: String): List<String> = buildList {
    if (arrivedAt.isBlank()) add("arrival")
    if (departedAt.isBlank()) add("departure")
}

/** The server's refusal, word for word. */
internal fun arrivalVerificationMessage(missing: List<String>): String {
    val steps = if (missing.size == 2) "arrival and departure" else missing.first()
    val which = if (missing.size == 2) "both" else "it"
    return "This visit has no $steps recorded, and your settings require $which " +
        "before a visit can be marked complete. Mark it on the visit card first, or turn off " +
        "\"Verify arrival and departure\" in Settings."
}

/**
 * Why Mark Completed would be refused, or null when it may be sent. [required]
 * is null while the setting is unknown (not loaded, or the read failed): the
 * console does not guess, the server decides.
 */
internal fun completeRefusal(required: Boolean?, session: KinCareSession): String? {
    if (required != true) return null
    val missing = missingVisitSteps(session.arrivedAt, session.departedAt)
    return if (missing.isEmpty()) null else arrivalVerificationMessage(missing)
}
