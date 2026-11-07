package com.tribetails.auntieos.domain

import com.tribetails.auntieos.data.model.KinCareSession

/**
 * ISSUE #1608: the operator's "Verify arrival and departure" rule, checked on
 * the phone BEFORE Complete is sent.
 *
 * The rule is the server's. `transitionBookingStatus` refuses COMPLETE with
 * `arrival_verification_required` when the switch is on and the session has no
 * `arrivedAt` or no `departedAt` (`mytribe/functions/src/lib/arrivalVerification.ts`).
 * Before this the operator pressed Complete, waited out a cold start, and only
 * then read a refusal the app could have given straight away. This file mirrors
 * the server's `missingVisitSteps` and `arrivalVerificationMessage` so the phone
 * says the same sentence without the round trip. The server check stays; this
 * is not the enforcement. Web's twin is `auntieos-admin/src/lib/completeRule.ts`.
 *
 * ABSENT MEANS OFF, as on the server: only an explicit `true` on the settings
 * document turns the rule on. [com.tribetails.auntieos.data.model.BusinessSettings]
 * defaults the field to `true` for the Settings editor, so the rule is read off
 * the raw document instead (`AuntieRepository.getArrivalRuleRequired`).
 *
 * Steps only. The #582 distance gate stays on the server, which owns the radius
 * and decides what a measured distance means.
 */

/** Is the rule on, for this raw settings value? Only an explicit `true` is. */
fun arrivalRuleRequired(raw: Any?): Boolean = raw == true

/** Which of the two steps this visit is missing, in the order they happen. Blank counts as missing. */
fun missingVisitSteps(arrivedAt: String?, departedAt: String?): List<String> = buildList {
    if (arrivedAt.isNullOrBlank()) add("arrival")
    if (departedAt.isNullOrBlank()) add("departure")
}

/** The server's refusal, word for word. */
fun arrivalVerificationMessage(missing: List<String>): String {
    val steps = if (missing.size == 2) "arrival and departure" else missing.first()
    val which = if (missing.size == 2) "both" else "it"
    return "This visit has no $steps recorded, and your settings require $which " +
        "before a visit can be marked complete. Mark it on the visit card first, or turn off " +
        "\"Verify arrival and departure\" in Settings."
}

/**
 * Why Complete would be refused, or null when it may be sent. [required] is
 * null while the setting is unknown (not loaded, or the read failed): the phone
 * does not guess, the server decides, which is what happened before this check.
 */
fun completeRefusal(required: Boolean?, session: KinCareSession): String? {
    if (required != true) return null
    val missing = missingVisitSteps(session.arrivedAt, session.departedAt)
    return if (missing.isEmpty()) null else arrivalVerificationMessage(missing)
}
