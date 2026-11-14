package com.kinfolk.portal.portal

import kotlin.coroutines.cancellation.CancellationException

/**
 * #1919: a booking write whose answer never came back may still have landed.
 *
 * The walk's reschedule ran past its budget, the page said it had not gone
 * through, and a reload showed the new time on file. #1281 covered the reply
 * that arrives; this covers the reply that does not. The web portal does the
 * same in `lib/bookingsCache.ts` (`visitAfterNoAnswer`).
 */

/**
 * How long a callable waits before it gives up, in seconds. The Android and
 * web builds of this app run with the Functions SDK's own default, 70 seconds.
 */
const val CALLABLE_NO_ANSWER_SECONDS: Int = 70

/**
 * What the household reads when a send got no answer and the visit does not
 * show it either. Plain words: no function name, no business name guessed at.
 */
fun noAnswerMessage(seconds: Int = CALLABLE_NO_ANSWER_SECONDS): String =
    "No answer came back within $seconds seconds, so it may still have gone through. Check before trying again."

/**
 * True when [t] is a call that ran out of time rather than a refusal. Each
 * platform says it its own way: Android's SDK throws `DEADLINE_EXCEEDED`, the
 * web SDK `functions/deadline-exceeded`, and the desktop's HTTP client a
 * socket or request timeout. A refusal the server wrote is never one of these,
 * so its words still reach the household as sent.
 */
fun isNoAnswerError(t: Throwable): Boolean {
    var cursor: Throwable? = t
    var depth = 0
    while (cursor != null && depth < 8) {
        if (cursor is CancellationException) return false
        val text = "${cursor.message.orEmpty()} ${cursor::class.simpleName.orEmpty()}".lowercase()
        if (("deadline" in text && "exceeded" in text) || "timeoutexception" in text) return true
        cursor = cursor.cause
        depth++
    }
    return false
}

/**
 * Reads the household's bookings fresh and hands back the list and the visit
 * when [landed] says the ask is on it. Null when the visit does not show the
 * ask, or the read itself fails: then nobody knows yet, and the screen says so.
 */
suspend fun PortalApi.visitAfterNoAnswer(
    kinfolkId: String,
    visitId: String,
    landed: (Booking) -> Boolean,
): Pair<BookingsResult, Booking>? {
    val fresh = try {
        getMyBookings(kinfolkId)
    } catch (c: CancellationException) {
        throw c
    } catch (_: Throwable) {
        return null
    }
    val visit = fresh.findBooking(visitId) ?: return null
    return if (landed(visit)) fresh to visit else null
}
