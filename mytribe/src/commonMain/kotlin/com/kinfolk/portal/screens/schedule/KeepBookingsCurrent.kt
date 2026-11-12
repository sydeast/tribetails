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
 * Every [BOOKINGS_POLL_MS] it asks [isBeingFollowed] whether anything is due,
 * and calls [refresh] only then. A household with nothing due today costs a
 * timer and no reads.
 *
 * [refresh] must be QUIET: it replaces the data when the read works and leaves
 * the screen exactly as it is when it does not. A dropped re-read is not a
 * failed screen, and the next turn tries again.
 */
@Composable
fun KeepBookingsCurrent(
    bookings: BookingsResult?,
    nowMs: () -> Long = { Clock.System.now().toEpochMilliseconds() },
    refresh: suspend () -> Unit,
) {
    val current by rememberUpdatedState(bookings)
    val latestRefresh by rememberUpdatedState(refresh)
    LaunchedEffect(Unit) {
        while (true) {
            delay(BOOKINGS_POLL_MS)
            if (current.isBeingFollowed(nowMs())) latestRefresh()
        }
    }
}
