package com.tribetails.auntieos.data.repository

import kotlin.random.Random

/**
 * #814: mints the id the SERVER will use for an outbound send, so a second
 * attempt at one send names the send the first attempt made.
 *
 * This is `BookingIdempotency.kt` applied to the two callables that put mail in
 * front of households, and the consequence of getting it wrong is worse. The
 * SDK reports `INTERNAL` for any transport failure, the same code whether the
 * request never reached the container or the fan-out committed and only the
 * reply was lost. Retrying repairs the first and sends the whole audience a
 * second copy in the second, and a marketing email cannot be recalled.
 *
 * ONE KEY PER SUBMISSION, NOT PER PRESS. See `MarketingBlastsViewModel` and
 * `CommunicateViewModel`, which hold the key while the campaign or the message
 * is unchanged and mint a new one the moment it changes.
 *
 * See `mytribe/functions/src/lib/sendIdempotency.ts` for the server half and for
 * why the value is shaped rather than a uuid: it becomes a Firestore document
 * id that readers downstream already see, and the callable's zod guard refuses
 * anything else.
 */
private const val KEY_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"

private fun mintSendKey(prefix: String, nowMs: Long, random: Random): String {
    val suffix = buildString { repeat(6) { append(KEY_ALPHABET[random.nextInt(KEY_ALPHABET.length)]) } }
    return "${prefix}_${nowMs}_$suffix"
}

/** The id of the `marketingBlasts/{id}` row `scheduleMarketingBlast` will create. */
fun mintBlastIdempotencyKey(
    nowMs: Long = System.currentTimeMillis(),
    random: Random = Random.Default,
): String = mintSendKey("blast", nowMs, random)

/** The id of the `broadcasts/{id}` row `broadcastMessage` will claim before it sends. */
fun mintBroadcastIdempotencyKey(
    nowMs: Long = System.currentTimeMillis(),
    random: Random = Random.Default,
): String = mintSendKey("bcast", nowMs, random)
