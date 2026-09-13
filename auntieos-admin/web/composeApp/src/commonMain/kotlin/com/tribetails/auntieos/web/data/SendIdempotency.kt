package com.tribetails.auntieos.web.data
import kotlin.random.Random
import kotlin.time.Clock
import kotlin.time.ExperimentalTime
/**
 * #814: mints the id the SERVER will use for an outbound send, so a second
 * attempt at one send names the send the first attempt made.
 *
 * `BookingIdempotency.kt` beside this file does the same job for booking
 * creation (#644). What is different here is the cost of getting it wrong: a
 * broadcast puts real email and SMS in front of every household an audience
 * matched, and a duplicate cannot be recalled.
 *
 * This console cannot retry automatically, `platformInvokeCallable` reports a
 * failure as a message string with no code, so it cannot tell a dropped request
 * from a refusal, and a retry it cannot classify is a guess. The key still
 * earns its place: it is what makes an OPERATOR pressing Send again land on the
 * broadcast the first press may already have sent. Same treatment #646 gave
 * this console for bookings.
 *
 * See `mytribe/functions/src/lib/sendIdempotency.ts` for the server half and for
 * why the value is shaped rather than a uuid.
 */
private const val KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
@OptIn(ExperimentalTime::class)
fun mintBroadcastIdempotencyKey(random: Random = Random.Default): String {
    val suffix = buildString { repeat(6) { append(KEY_ALPHABET[random.nextInt(KEY_ALPHABET.length)]) } }
    return "bcast_${Clock.System.now().toEpochMilliseconds()}_$suffix"
}
