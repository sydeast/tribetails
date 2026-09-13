package com.tribetails.auntieos.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The threshold decision as a decision table, with no Compose host.
 *
 * The fourth copy of one rule. Its twins are `auntieos-admin/src/lib/
 * slowWait.test.ts`, `mytribe/web/src/lib/slowWait.test.ts` and
 * `mytribe/src/commonTest/.../SlowWaitTest.kt`; between them they pin the same
 * number and the same offline behaviour on every client the operator can pick
 * up. If one drifts, exactly one of these four fails and says which.
 *
 * A plain JUnit test rather than a Compose one on purpose. `AuntieSpinner` runs
 * an infinite transition, so a composition containing it is never idle, and a
 * UI test would have to drive a virtual clock to a ten-second deadline to reach
 * the assertion. The rule is arithmetic; this is where arithmetic is tested.
 */
class SlowWaitTest {

    @Test
    fun `idle when nothing is in flight`() {
        assertEquals(WaitPhase.Idle, waitPhase(startedAtMs = null, nowMs = 1_000_000, online = true))
    }

    @Test
    fun `waiting the instant a wait starts`() {
        assertEquals(WaitPhase.Waiting, waitPhase(startedAtMs = 1_000L, nowMs = 1_000L, online = true))
    }

    /**
     * The measured cold start here is 7.9s to 9.4s -- the number issue #714 was
     * filed about. A healthy cold start must not be dressed up as a fault, or
     * the operator learns to tap through a wait that was always going to land.
     */
    @Test
    fun `stays waiting across the whole measured cold start range`() {
        for (elapsed in listOf(7_900L, 8_500L, 9_400L, 9_999L)) {
            assertEquals(
                "a $elapsed ms wait is a normal cold start and must not escalate",
                WaitPhase.Waiting,
                waitPhase(startedAtMs = 0L, nowMs = elapsed, online = true),
            )
        }
    }

    @Test
    fun `escalates exactly at the threshold`() {
        assertEquals(WaitPhase.Waiting, waitPhase(0L, SLOW_WAIT_MS - 1, online = true))
        assertEquals(WaitPhase.Slow, waitPhase(0L, SLOW_WAIT_MS, online = true))
    }

    /**
     * 10s leaves the other half of `fns.ts#CALLABLE_TIMEOUT_MS` (20s) for the
     * operator to read the offer and use it. An escalation offered later than
     * the budget would never be seen: the callable would already have rejected.
     */
    @Test
    fun `escalates with the callable budget still running`() {
        assertTrue(SLOW_WAIT_MS < 20_000L)
        assertEquals(WaitPhase.Slow, waitPhase(0L, 19_999L, online = true))
    }

    /**
     * THE DISCRIMINATING CASE. A device with no signal is not waiting on a slow
     * server and must never be handed a Sync button that fails the moment it is
     * pressed.
     */
    @Test
    fun `never escalates while offline however long the wait`() {
        assertEquals(WaitPhase.Waiting, waitPhase(0L, 60_000L, online = false))
        assertEquals(WaitPhase.Waiting, waitPhase(0L, 600_000L, online = false))
    }

    @Test
    fun `escalates on the remaining time when signal returns mid wait`() {
        assertEquals(WaitPhase.Slow, waitPhase(0L, 30_000L, online = true))
    }

    @Test
    fun `honours a caller supplied threshold`() {
        assertEquals(WaitPhase.Waiting, waitPhase(0L, 2_000L, online = true, thresholdMs = 3_000L))
        assertEquals(WaitPhase.Slow, waitPhase(0L, 3_000L, online = true, thresholdMs = 3_000L))
    }
}
