package com.tribetails.auntieos.data.repository

import kotlin.random.Random

/**
 * #644: mints the booking id the SERVER used to mint, so a second attempt at
 * one submission names the booking the first attempt made.
 *
 * #630 established that Cloud Run can drop a request before it reaches the
 * container, and that the SDK reports that as `INTERNAL` — the same code it
 * reports when the write committed and only the reply was lost. Moving the id
 * to the client is what lets the server tell those apart, and it is the only
 * reason `BookingRepository.createMultiDateBookingRequest` may retry at all.
 *
 * See `mytribe/functions/src/lib/bookingIdempotency.ts` for the server half and
 * for why the format is `req_<millis>_<suffix>` rather than a uuid: the value
 * becomes a Firestore document id every reader downstream already sees, and the
 * callable's zod guard refuses anything that is not the shape the server has
 * always minted.
 *
 * ONE KEY PER SUBMISSION, NOT PER PRESS. See
 * `EnhancedSchedulingViewModel.createBookingRequest`, which holds the key while
 * the booking is unchanged and mints a new one when it changes.
 */
private const val KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

fun mintBookingIdempotencyKey(
    nowMs: Long = System.currentTimeMillis(),
    random: Random = Random.Default,
): String {
    val suffix = buildString { repeat(6) { append(KEY_ALPHABET[random.nextInt(KEY_ALPHABET.length)]) } }
    return "req_${nowMs}_$suffix"
}
