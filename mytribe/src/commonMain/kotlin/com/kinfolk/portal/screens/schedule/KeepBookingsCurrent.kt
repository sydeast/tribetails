package com.kinfolk.portal.screens.schedule

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import com.kinfolk.portal.portal.BOOKINGS_POLL_MS
import com.kinfolk.portal.portal.BookingsResult
import com.kinfolk.portal.portal.isBeingFollowed
import kotlinx.coroutines.delay
import kotlin.time.Clock

/**
 * #1823 / #1832: keeps an open screen's schedule current while a visit could
 * change under the household's eyes, so On the way, Arrived and Departed show
 * without leaving the screen and coming back, and the live card clears when
 * the Auntie leaves. Home, Schedule and the booking screen all use it.
 *
 * Every [pollMs] (the app always uses [BOOKINGS_POLL_MS]) it asks
 * [isBeingFollowed] whether anything is due, and calls [refresh] only then. A
 * household with nothing due today costs a timer and no reads.
 *
 * [refresh] must be QUIET: it replaces the data when the read works and leaves
 * the screen exactly as it is when it does not. A dropped re-read is not a
 * failed screen, and the next turn tries again.
 *
 * #2122: [pollMs] is a parameter only so the screen tests can follow a visit
 * through its stages in a few seconds of test time. A Compose UI test draws
 * every 16 ms frame of the time it moves through, for real, so following a
 * visit at the real 30 seconds a turn drew about 13,000 frames and ran past
 * the test's one minute limit on a busy machine. The 30 second rule itself is
 * proven without drawing anything, on [followBookings].
 */
@Composable
fun KeepBookingsCurrent(
    bookings: BookingsResult?,
    nowMs: () -> Long = { Clock.System.now().toEpochMilliseconds() },
    pollMs: Long = BOOKINGS_POLL_MS,
    refresh: suspend () -> Unit,
) {
    val current by rememberUpdatedState(bookings)
    val latestRefresh by rememberUpdatedState(refresh)
    LaunchedEffect(pollMs) {
        followBookings(pollMs, isDue = { current.isBeingFollowed(nowMs()) }) { latestRefresh() }
    }
}

/**
 * The turn [KeepBookingsCurrent] runs for as long as its screen is open: wait
 * [pollMs], then [refresh] if [isDue] says something is due, and again. It
 * ends only when its screen leaves (the effect is cancelled).
 */
suspend fun followBookings(
    pollMs: Long,
    isDue: () -> Boolean,
    refresh: suspend () -> Unit,
) {
    while (true) {
        delay(pollMs)
        if (isDue()) refresh()
    }
}
