package com.tribetails.auntieos.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for AuntiePullRefresh gesture decision logic. Indicator
 * geometry + nestedScroll wiring tested by visual smoke; thresholds + progress
 * mapping tested here.
 */
class AuntiePullRefreshTest {

    @Test
    fun `computePullProgress maps 0 to 0`() {
        assertEquals(0f, computePullProgress(offsetPx = 0f, thresholdPx = 240f), 0.001f)
    }

    @Test
    fun `computePullProgress maps half threshold to one-half`() {
        assertEquals(0.5f, computePullProgress(offsetPx = 120f, thresholdPx = 240f), 0.001f)
    }

    @Test
    fun `computePullProgress clamps above 1f`() {
        assertEquals(1f, computePullProgress(offsetPx = 999f, thresholdPx = 240f), 0.001f)
    }

    @Test
    fun `computePullProgress negative offset returns 0`() {
        assertEquals(0f, computePullProgress(offsetPx = -50f, thresholdPx = 240f), 0.001f)
    }

    @Test
    fun `computePullProgress zero threshold returns 0 (avoid div by zero)`() {
        assertEquals(0f, computePullProgress(offsetPx = 50f, thresholdPx = 0f), 0.001f)
    }

    @Test
    fun `shouldTriggerRefresh true only when offset exceeds threshold and not already refreshing`() {
        assertTrue(shouldTriggerRefresh(offsetPx = 250f, thresholdPx = 240f, isRefreshing = false))
        assertFalse(shouldTriggerRefresh(offsetPx = 200f, thresholdPx = 240f, isRefreshing = false))
        assertFalse(shouldTriggerRefresh(offsetPx = 250f, thresholdPx = 240f, isRefreshing = true))
    }

    @Test
    fun `applyPullResistance halves incoming drag delta`() {
        // 100px raw drag → 50px applied (matches 0.5 resistance factor)
        assertEquals(50f, applyPullResistance(rawDeltaY = 100f), 0.001f)
    }

    @Test
    fun `applyPullResistance returns 0 for non-positive delta`() {
        assertEquals(0f, applyPullResistance(rawDeltaY = 0f), 0.001f)
        assertEquals(0f, applyPullResistance(rawDeltaY = -42f), 0.001f)
    }
}
