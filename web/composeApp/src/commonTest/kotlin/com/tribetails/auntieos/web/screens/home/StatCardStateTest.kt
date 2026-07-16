package com.tribetails.auntieos.web.screens.home

import com.tribetails.auntieos.web.data.FirestoreResult
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Home's four stat cards must never render a failed read as a number.
 *
 * LIVE-CAUGHT 2026-07-15 on production: `bookingRequestsStream()` is
 * `whereEqStream("kin_care_sessions", "status", "DRAFT")`, and when Firestore
 * denied it the console logged the permission error while the card rendered
 * "Open bookings: 0 / needs a reply". `openBookings` is
 * `(bookingsState as? Data)?.value?.size ?: 0`, so Error collapses to 0. There is
 * no bookings panel on Home, so nothing else surfaced it: an operator with real
 * requests waiting would have seen a confident zero.
 *
 * Three of the four cards had no Error branch. "This week" already had one, which
 * is what these helpers generalise, so every card tells the truth the same way.
 *
 * The distinction pinned here is the same one as the booking-price fix: a FAILED
 * READ is not a ZERO. An empty inbox and an unreadable inbox must not look alike.
 */
class StatCardStateTest {

    private val ok = FirestoreResult.Data(listOf(1, 2, 3))
    private val loading = FirestoreResult.Loading
    private val boom = FirestoreResult.Error("Missing or insufficient permissions.")

    // ── value ────────────────────────────────────────────────────────────────

    @Test
    fun `data renders the real value`() {
        assertEquals("3", statCardValue(ok, ready = "3"))
    }

    @Test
    fun `loading renders the ellipsis, not a zero`() {
        assertEquals("…", statCardValue(loading, ready = "0"))
    }

    @Test
    fun `error renders a dash, never the fallback count`() {
        // The whole bug: `?: 0` upstream means `ready` is "0" on error. The card
        // must not print that, or a broken read is indistinguishable from an empty one.
        assertEquals("-", statCardValue(boom, ready = "0"))
    }

    @Test
    fun `a genuine zero still renders as zero`() {
        assertEquals("0", statCardValue(FirestoreResult.Data(emptyList<Int>()), ready = "0"))
    }

    // ── trend ────────────────────────────────────────────────────────────────

    @Test
    fun `data keeps the normal trend copy`() {
        assertEquals("needs a reply", statCardTrend(ok, ready = "needs a reply", failed = "Couldn't load bookings"))
    }

    @Test
    fun `error swaps the trend for something that says it broke`() {
        assertEquals(
            "Couldn't load bookings",
            statCardTrend(boom, ready = "needs a reply", failed = "Couldn't load bookings"),
        )
    }

    @Test
    fun `loading keeps the normal trend rather than claiming a failure`() {
        assertEquals("needs a reply", statCardTrend(loading, ready = "needs a reply", failed = "Couldn't load bookings"))
    }

    // ── the roll-up animation must not play over a non-number ─────────────────

    @Test
    fun `error suppresses the numeric roll so the card cannot animate to zero`() {
        // numericValue drives the count-up. Rolling to 0 on a failed read would
        // animate a lie, which is louder than printing one.
        assertEquals(null, statCardNumeric(boom, ready = 0.0))
        assertEquals(null, statCardNumeric(loading, ready = 0.0))
        assertEquals(3.0, statCardNumeric(ok, ready = 3.0))
    }
}
