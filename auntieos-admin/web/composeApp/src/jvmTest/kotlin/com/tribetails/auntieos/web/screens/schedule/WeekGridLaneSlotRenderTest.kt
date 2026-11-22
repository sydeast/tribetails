package com.tribetails.auntieos.web.screens.schedule

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.getBoundsInRoot
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.runDesktopComposeUiTest
import androidx.compose.ui.unit.dp
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #1861: the lane modifier, measured on a real layout pass and chained the way
 * `EventBlock` chains it (lane, then the block's top and side padding).
 */
@OptIn(ExperimentalTestApi::class)
class WeekGridLaneSlotRenderTest {

    private fun blockModifier(lane: GridLane, tag: String, topDp: Int = 0) =
        Modifier
            .laneSlot(lane)
            .padding(top = topDp.dp, start = 5.dp, end = 5.dp)
            .fillMaxWidth()
            .height(20.dp)
            .testTag(tag)

    @Test
    fun aLoneBlockKeepsTheWholeColumn() = runDesktopComposeUiTest {
        setContent {
            Box(Modifier.size(width = 300.dp, height = 100.dp)) {
                Box(blockModifier(GridLane(0, 1), "lone"))
            }
        }
        val bounds = onNodeWithTag("lone").getBoundsInRoot()
        assertEquals(5f, bounds.left.value, 0.5f)
        assertEquals(295f, bounds.right.value, 0.5f)
    }

    @Test
    fun overlappingBlocksSitSideBySideWithoutCrossing() = runDesktopComposeUiTest {
        setContent {
            Box(Modifier.size(width = 300.dp, height = 100.dp)) {
                Box(blockModifier(GridLane(0, 3), "a"))
                Box(blockModifier(GridLane(1, 3), "b"))
                Box(blockModifier(GridLane(2, 3), "c"))
            }
        }
        val a = onNodeWithTag("a").getBoundsInRoot()
        val b = onNodeWithTag("b").getBoundsInRoot()
        val c = onNodeWithTag("c").getBoundsInRoot()
        assertEquals(5f, a.left.value, 0.5f)
        assertEquals(95f, a.right.value, 0.5f)
        assertEquals(105f, b.left.value, 0.5f)
        assertEquals(195f, b.right.value, 0.5f)
        assertEquals(205f, c.left.value, 0.5f)
        assertEquals(295f, c.right.value, 0.5f)
        assertTrue(a.right < b.left && b.right < c.left)
    }

    @Test
    fun theLaneKeepsTheBlocksOwnTop() = runDesktopComposeUiTest {
        setContent {
            Box(Modifier.size(width = 300.dp, height = 100.dp)) {
                Box(blockModifier(GridLane(1, 2), "lower", topDp = 40))
            }
        }
        val bounds = onNodeWithTag("lower").getBoundsInRoot()
        assertEquals(40f, bounds.top.value, 0.5f)
        assertEquals(60f, bounds.bottom.value, 0.5f)
        assertEquals(155f, bounds.left.value, 0.5f)
        assertEquals(295f, bounds.right.value, 0.5f)
    }
}
