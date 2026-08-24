package com.tribetails.auntieos.ui.kintales

import com.tribetails.auntieos.data.model.VisitStatus

/**
 * The KinTale composer's rules, as the same rules the React composer enforces.
 *
 * The web side wrote these as a real executable schema
 * (`auntieos-admin/src/lib/kinTaleDraftSchema.ts`) precisely so they would stop
 * being aspirational prose that the two clients drift apart on. Android had the
 * composer screen but none of the rules, so a headline with an em dash in it
 * went out from a phone and was refused on the desktop, and only one of the two
 * surfaces ever said why.
 *
 * Ported field for field and message for message. Same wording, because an
 * operator who reads "Auntie does not use dashes" on the desktop and something
 * else on the phone has to learn the rule twice.
 *
 * A KinTale draft is not written through a callable on either client: both write
 * `kin_care_reports` directly, gated by `firestore.rules` (`allow create/update:
 * if isAuntie()`). There is therefore no server-side Zod contract to mirror.
 * These rules ARE the contract, which is exactly why they have to be enforced on
 * both clients rather than described on one.
 */

/**
 * Long enough to be a real headline, short enough to survive the KinTale list
 * without truncation. The generator is told 2 to 6 words, so a generated title
 * lands well inside this. Same number as the web's `TITLE_MAX`.
 */
const val KIN_TALE_TITLE_MAX = 120

/**
 * The one rule Auntie's voice enforces mechanically (Voice Bible section 11): no
 * em dashes, no en dashes, ever. The backend strips them out of generated copy;
 * an operator who types one by hand is TOLD rather than silently rewritten,
 * because rewriting someone's punctuation under them is worse than asking.
 */
private val NO_DASHES = Regex("[—–]")

private const val DASH_MESSAGE =
    "Auntie does not use dashes. Try a comma, ellipses (.....), or parentheses."

/** The headline's first problem, or null when it is clean. */
fun kinTaleTitleError(title: String): String? {
    val trimmed = title.trim()
    if (trimmed.length > KIN_TALE_TITLE_MAX) {
        return "Keep the headline under $KIN_TALE_TITLE_MAX characters."
    }
    if (NO_DASHES.containsMatchIn(trimmed)) return DASH_MESSAGE
    return null
}

/**
 * The body's first problem, or null when it is clean.
 *
 * Unlike the headline the body has no length cap: a recap of a long visit is a
 * long recap, and there is no list column for it to overflow.
 */
fun kinTaleBodyError(body: String): String? =
    if (NO_DASHES.containsMatchIn(body)) DASH_MESSAGE else null

/**
 * The extra rule that only applies at SEND time, kept off the field validators so
 * a half-finished draft is never blocked from SAVING.
 *
 * A tale with no session could never be sent anyway: the send transition has to
 * reach the parent `kin_care_sessions` doc to record the send. Saying so is
 * better than a Send button that fails at the wire.
 */
fun kinTaleSendBlocker(sessionId: String): String? =
    if (sessionId.isBlank()) {
        "This tale is not linked to an Auntie Time visit, so it cannot be sent. Save it as a draft."
    } else {
        null
    }

/**
 * Positive membership: only a visit that has ACTUALLY HAPPENED is one you can
 * start a KinTale from.
 *
 * Two states qualify, [VisitStatus.DEPARTED] and [VisitStatus.COMPLETED], and the
 * test names them rather than negating the four that do not. A status this build
 * has never heard of therefore stays OUT of the picker, which is the answer we
 * want: a SCHEDULED / ON_MY_WAY / ARRIVED visit has no recap to write yet, and a
 * CANCELLED one never will.
 *
 * Same rule and same shape as the web's `isKinTaleEligibleSession`, which reads
 * its status through `sessionState()`; the trim-and-uppercase here is that
 * normalisation, since Firestore hands these back as free text.
 */
fun isKinTaleEligibleSession(status: String): Boolean =
    when (status.trim().uppercase()) {
        VisitStatus.DEPARTED.name, VisitStatus.COMPLETED.name -> true
        else -> false
    }
