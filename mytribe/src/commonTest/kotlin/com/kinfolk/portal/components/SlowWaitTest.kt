package com.kinfolk.portal.components

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The threshold decision as a decision table, with no Compose host and no
 * virtual clock. The twin of `mytribe/web/src/lib/slowWait.test.ts` and
 * `auntieos-admin/src/lib/slowWait.test.ts`; four clients, one rule, and this
 * is the spec that proves the Kotlin half agrees with the TypeScript half.
 *
 * In commonTest rather than composeUiTest on purpose: it needs no Compose host,
 * so it runs on every target including `testDebugUnitTest`, and per
 * mytribe/CLAUDE.md a UI test that does not need a host does not belong in the
 * source set reserved for ones that do.
 */
class SlowWaitTest {

    @Test
    fun idleWhenNothingInFlight() {
        assertEquals(WaitPhase.Idle, waitPhase(startedAtMs = null, nowMs = 1_000_000, online = true))
    }

    @Test
    fun waitingTheInstantAWaitStarts() {
        assertEquals(WaitPhase.Waiting, waitPhase(startedAtMs = 1_000L, nowMs = 1_000L, online = true))
    }

    /**
     * The measured cold start on this project is 7.9s to 9.4s. A healthy cold
     * start must not be dressed up as a fault, or a household learns to tap
     * through a wait that was always going to land on its own.
     */
    @Test
    fun staysWaitingAcrossTheMeasuredColdStartRange() {
        for (elapsed in listOf(7_900L, 8_500L, 9_400L, 9_999L)) {
            assertEquals(
                WaitPhase.Waiting,
                waitPhase(startedAtMs = 0L, nowMs = elapsed, online = true),
                "a $elapsed ms wait is a normal cold start and must not escalate",
            )
        }
    }

    @Test
    fun escalatesExactlyAtTheThreshold() {
        assertEquals(WaitPhase.Waiting, waitPhase(0L, SLOW_WAIT_MS - 1, online = true))
        assertEquals(WaitPhase.Slow, waitPhase(0L, SLOW_WAIT_MS, online = true))
    }

    /**
     * 10s leaves the other half of the 20s client callable budget
     * (`fns.ts#CALLABLE_TIMEOUT_MS`) for somebody to read the offer and use it.
     * An escalation offered later than the budget would never be seen.
     */
    @Test
    fun escalatesWithTheCallableBudgetStillRunning() {
        assertTrue(SLOW_WAIT_MS < 20_000L)
        assertEquals(WaitPhase.Slow, waitPhase(0L, 19_999L, online = true))
    }

    /**
     * THE DISCRIMINATING CASE. A phone with no bars is not waiting on a slow
     * server and must never be handed a Sync button that fails the moment it is
     * pressed. Offline keeps whatever treatment its screen already has.
     */
    @Test
    fun neverEscalatesWhileOffline() {
        assertEquals(WaitPhase.Waiting, waitPhase(0L, 60_000L, online = false))
        assertEquals(WaitPhase.Waiting, waitPhase(0L, 600_000L, online = false))
    }

    @Test
    fun escalatesOnRemainingTimeWhenSignalReturns() {
        assertEquals(WaitPhase.Slow, waitPhase(0L, 30_000L, online = true))
    }

    @Test
    fun honoursACallerSuppliedThreshold() {
        assertEquals(WaitPhase.Waiting, waitPhase(0L, 2_000L, online = true, thresholdMs = 3_000L))
        assertEquals(WaitPhase.Slow, waitPhase(0L, 3_000L, online = true, thresholdMs = 3_000L))
    }
}
