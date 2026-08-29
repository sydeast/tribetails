package com.tribetails.auntieos.web.data

import kotlin.random.Random
import kotlin.time.Clock
import kotlin.time.ExperimentalTime

/**
 * #644: mints the booking id the SERVER used to mint, so a second attempt at
 * one submission names the booking the first attempt made.
 *
 * #630 established that Cloud Run can drop a request before it reaches the
 * container, and that the failure is reported the same way as a lost reply.
 * Moving the id to the client is what lets the server tell those apart:
 * `createMultiDateBookingRequest` reads this as the envelope id and returns the
 * stored booking rather than writing a second one. See
 * `mytribe/functions/src/lib/bookingIdempotency.ts` for the server half and for
 * why the format is `req_<millis>_<suffix>` rather than a uuid -- the value
 * becomes a Firestore document id, and the callable's zod guard refuses
 * anything that is not the shape the server has always minted.
 *
 * ONE KEY PER SUBMISSION, NOT PER PRESS. Callers hold the key while the booking
 * being submitted is unchanged and mint a new one when it changes; see
 * `BookingViewModel.createBookingRequest`.
 */
private const val KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

@OptIn(ExperimentalTime::class)
fun mintBookingIdempotencyKey(random: Random = Random.Default): String {
    val suffix = buildString { repeat(6) { append(KEY_ALPHABET[random.nextInt(KEY_ALPHABET.length)]) } }
    return "req_${Clock.System.now().toEpochMilliseconds()}_$suffix"
}
