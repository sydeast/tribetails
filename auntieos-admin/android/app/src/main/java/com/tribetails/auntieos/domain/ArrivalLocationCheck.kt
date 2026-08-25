package com.tribetails.auntieos.domain

/**
 * ISSUE #582: what the phone does with the arrival-location check, and what it
 * tells the Auntie about it.
 *
 * NO ARITHMETIC LIVES HERE, DELIBERATELY. The distance, the operator's radius
 * and the accuracy rule are all the server's (`verifyVisitArrival`), so this
 * file never computes a distance and never decides whether one is acceptable.
 * It decodes the verdict and words it. A second implementation of the rule on
 * the phone would be a second answer to the same question, and the two would
 * drift the first time the radius meant something slightly different on either
 * side.
 *
 * THE CHECK NEVER BLOCKS AN ARRIVAL. Marking Arrived is a direct Firestore
 * patch on an offline write queue, and it stays exactly that. This runs after
 * it, best effort, and its whole job is to tell the Auntie NOW what the server
 * would otherwise only tell her when she tried to complete the visit — which is
 * the difference between a fixable problem and being stuck at the end of a day.
 */

/** The verdicts `verifyVisitArrival` returns, as a type rather than a string. */
enum class ArrivalCheckStatus {
    /** Measured inside the operator's radius. */
    WITHIN,

    /** Measured confidently outside it. This visit cannot be marked complete as it stands. */
    OUTSIDE,

    /** A fix arrived but was too imprecise to be evidence of anything. */
    UNVERIFIED,

    /** No coordinate for this household: no address, an address we cannot place, or the geocoder is down. */
    HOUSEHOLD_LOCATION_UNKNOWN,

    ;

    companion object {
        /**
         * The wire value, or [UNVERIFIED] for anything unrecognised.
         *
         * An unknown verdict falls to "we could not verify" rather than to a
         * pass or a refusal: a phone that has not been updated must not start
         * telling the Auntie a visit is fine, nor that she is in the wrong
         * place, on the strength of a word it does not know.
         */
        fun fromWire(raw: String?): ArrivalCheckStatus = when (raw?.trim()?.lowercase()) {
            "within" -> WITHIN
            "outside" -> OUTSIDE
            "household_location_unknown" -> HOUSEHOLD_LOCATION_UNKNOWN
            else -> UNVERIFIED
        }
    }
}

/** One arrival check, as the server reported it. */
data class ArrivalCheckOutcome(
    val status: ArrivalCheckStatus,
    /** Metres from the household. Null when no household coordinate could be resolved. */
    val distanceMeters: Double? = null,
    /** The operator's radius, echoed by the server so this phone need not read settings to word a message. */
    val radiusMeters: Int = 150,
    /** False when the operator has arrival verification switched off entirely. */
    val verificationRequired: Boolean = false,
)

/** Metres as the Auntie reads them on a phone: `40 m`, `1.2 km`. */
internal fun formatArrivalDistance(meters: Double): String =
    if (meters < 1000) "${Math.round(meters)} m" else "${Math.round(meters / 100.0) / 10.0} km"

/**
 * What to say to the Auntie about an arrival she has already recorded, or null
 * when there is nothing worth saying.
 *
 * SILENT ON THE HAPPY PATH. A visit verified at the household needs no message:
 * the arrival is on the card, and a "you are where you said you were" toast
 * after every single arrival is noise that trains people to dismiss the one
 * that matters.
 *
 * SILENT WHEN THE OPERATOR IS NOT ASKING. With verification off, nothing the
 * check found can stop anything, so telling the Auntie about a distance would
 * be reporting a rule that does not exist.
 *
 * LOUD, AND SPECIFIC, WHEN THE VISIT CANNOT BE COMPLETED AS IT STANDS. That is
 * the message this whole path exists to deliver, and it is delivered at
 * arrival — while she is still standing there and can do something about it —
 * rather than hours later at COMPLETE.
 */
fun arrivalCheckNotice(outcome: ArrivalCheckOutcome?): String? {
    if (outcome == null) return null
    if (!outcome.verificationRequired) return null
    return when (outcome.status) {
        ArrivalCheckStatus.WITHIN -> null
        ArrivalCheckStatus.OUTSIDE -> {
            val where = outcome.distanceMeters?.let { formatArrivalDistance(it) } ?: "a long way"
            "Your arrival was recorded $where from this household, and your settings require it " +
                "within ${formatArrivalDistance(outcome.radiusMeters.toDouble())}. This visit " +
                "cannot be marked complete until it is recorded from the household."
        }
        ArrivalCheckStatus.UNVERIFIED ->
            "Arrival recorded, but your location was too rough to check against the household. " +
                "The visit can still be completed; it will be recorded as unverified."
        ArrivalCheckStatus.HOUSEHOLD_LOCATION_UNKNOWN ->
            "Arrival recorded. We could not check it against the household, because we have no " +
                "map location for their address. The visit can still be completed; it will be " +
                "recorded as unverified."
    }
}

/**
 * The same, for the case where no fix could be taken at all — location off,
 * permission denied, indoors with no signal, or offline so the check never ran.
 *
 * Only worth saying while the operator requires verification, and it says the
 * visit is fine, because it is: the server allows a completion with no location
 * evidence, and an Auntie who is told otherwise will start doing something
 * pointless about it.
 */
fun arrivalNoFixNotice(verificationRequired: Boolean): String? =
    if (!verificationRequired) {
        null
    } else {
        "Arrival recorded. Your phone gave us no location fix, so we could not check where you " +
            "are and this visit will be recorded as unverified. It can still be completed."
    }
