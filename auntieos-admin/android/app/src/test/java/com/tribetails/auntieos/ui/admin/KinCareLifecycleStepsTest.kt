package com.tribetails.auntieos.ui.admin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Pure-helper tests for the "Visit lifecycle" stepper (#755). Each node is
 * lit from its OWN stamp, never from its position before the current state:
 * the defect this pins is a visit the office completed from Bookings with no
 * clock-out reading as though someone had clocked out of it. Mirrors the
 * `lifecycleSteps` cases in web's `SessionDetail.test.tsx`.
 */
class KinCareLifecycleStepsTest {

    private fun moods(steps: List<LifecycleStep>) = steps.associate { it.name to it.mood }

    @Test
    fun `a fresh visit lights Scheduled as now and the rest as still to come`() {
        val steps = lifecycleSteps("SCHEDULED", null, null, null, null)
        assertEquals(
            mapOf(
                "Scheduled" to LifecycleMood.Now,
                "On my way" to LifecycleMood.Todo,
                "Arrived" to LifecycleMood.Todo,
                "Departed" to LifecycleMood.Todo,
                "Completed" to LifecycleMood.Todo,
            ),
            moods(steps),
        )
        assertEquals(0f, lifecycleProgress(steps))
    }

    @Test
    fun `stamped steps are done, the current one is now, and the bar runs to it`() {
        val steps = lifecycleSteps("ARRIVED", "2026-08-19T13:48:00", "2026-08-19T14:02:00", "", "")
        assertEquals(LifecycleMood.Done, moods(steps)["Scheduled"])
        assertEquals(LifecycleMood.Done, moods(steps)["On my way"])
        assertEquals(LifecycleMood.Now, moods(steps)["Arrived"])
        assertEquals(LifecycleMood.Todo, moods(steps)["Departed"])
        assertEquals("2026-08-19T14:02:00", steps[2].stamp)
        assertEquals(0.5f, lifecycleProgress(steps))
    }

    @Test
    fun `an office completion with no clock-out leaves Departed unlit`() {
        val steps = lifecycleSteps("COMPLETED", null, null, "", "2026-08-19T18:00:00")
        assertEquals(LifecycleMood.Todo, moods(steps)["Arrived"])
        assertEquals(LifecycleMood.Todo, moods(steps)["Departed"])
        assertEquals(LifecycleMood.Now, moods(steps)["Completed"])
        // The bar still reaches the lit node, gaps and all.
        assertEquals(1f, lifecycleProgress(steps))
    }

    @Test
    fun `a cancelled visit lights no current node and shows what was stamped`() {
        val steps = lifecycleSteps("cancelled", "2026-08-19T13:48:00", null, null, null)
        assertNull(steps.firstOrNull { it.mood == LifecycleMood.Now })
        assertEquals(LifecycleMood.Done, moods(steps)["On my way"])
        assertEquals(LifecycleMood.Todo, moods(steps)["Arrived"])
    }

    @Test
    fun `status is matched case-insensitively, the way every other reader of it does`() {
        assertEquals(LifecycleMood.Now, moods(lifecycleSteps("departed", "", "x", "y", null))["Departed"])
    }
}
