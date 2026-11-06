package com.tribetails.auntieos.domain

/**
 * Whether a `generated_drafts` doc is still waiting on a decision, the
 * question Home's "KinTales to review" card counts (#1601).
 *
 * The same rule as the admin web's `draftStatusAsKinTaleStatus`: generated,
 * pending and blank are drafts; approved and anything unrecognised are not.
 * Android used to count `status == "pending"` only, so a fresh "generated"
 * draft was missing from the card while the web card and list showed it.
 */
fun isDraftAwaitingReview(status: String?): Boolean =
    when (status?.trim()?.lowercase().orEmpty()) {
        "generated", "pending", "" -> true
        else -> false
    }
