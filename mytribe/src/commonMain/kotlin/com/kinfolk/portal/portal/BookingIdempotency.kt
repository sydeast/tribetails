package com.kinfolk.portal.portal

import kotlin.random.Random
import kotlin.time.Clock
import kotlin.time.ExperimentalTime

/**
 * #644: mints the booking id the SERVER used to mint, so a second attempt at
 * one submission names the booking the first attempt made.
 *
 * #630 established that Cloud Run can drop a booking request before it reaches
 * the container, and that the failure looks exactly like a lost reply. Moving
 * the id to the client is what lets the server tell those apart:
 * `requestBooking` reads this as the envelope id and returns the booking it
 * already stored rather than writing a second one. See
 * `mytribe/functions/src/lib/bookingIdempotency.ts` for the server half, and for
 * why the format is `req_<millis>_<suffix>` rather than a uuid -- the value
 * becomes a Firestore document id, and the callable's zod guard refuses
 * anything that is not the shape the server has always minted.
 *
 * This matters more on the portal than anywhere else: where the operator has
 * `autoConfirmRepeatKinfolk` on, a duplicated request is auto-approved on
 * arrival, so the household ends up with a second set of CONFIRMED sessions and
 * the Aunties with a second set of visits on the calendar.
 *
 * `FunctionsClient.call` throws a plain `Throwable` with no code -- it is one
 * facade over gitlive on android and REST on jvm -- so this client cannot tell
 * a dropped request from a refusal and does NOT retry on its own. The key is
 * still what it needs: it makes the household tapping Create Booking again,
 * after seeing an error, land on the booking the first tap may already have
 * made.
 *
 * ONE KEY PER SUBMISSION, NOT PER TAP. See `BookingWizardScreen`.
 */
private const val KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

@OptIn(ExperimentalTime::class)
fun mintBookingIdempotencyKey(random: Random = Random.Default): String {
    val suffix = buildString { repeat(6) { append(KEY_ALPHABET[random.nextInt(KEY_ALPHABET.length)]) } }
    return "req_${Clock.System.now().toEpochMilliseconds()}_$suffix"
}
