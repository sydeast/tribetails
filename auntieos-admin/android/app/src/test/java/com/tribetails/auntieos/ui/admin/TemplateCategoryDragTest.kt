package com.tribetails.auntieos.ui.admin

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Pins the drag-drop category hit-test (mirror of the web TemplateCategoryDragTest)
 * so a drop assigns the same category on both consoles.
 */
class TemplateCategoryDragTest {

    private val targets = mapOf(
        "Reminders" to Rect(left = 0f, top = 0f, right = 100f, bottom = 40f),
        "Receipts"  to Rect(left = 110f, top = 0f, right = 210f, bottom = 40f),
    )

    @Test
    fun dropTarget_insideChip_returnsThatCategory() {
        assertEquals("Reminders", categoryDropTarget(Offset(50f, 20f), targets))
        assertEquals("Receipts", categoryDropTarget(Offset(150f, 20f), targets))
    }

    @Test
    fun dropTarget_outsideAllChips_returnsNull() {
        assertNull(categoryDropTarget(Offset(50f, 200f), targets))
        assertNull(categoryDropTarget(Offset(105f, 20f), targets))
    }

    @Test
    fun dropTarget_emptyTargets_returnsNull() {
        assertNull(categoryDropTarget(Offset(50f, 20f), emptyMap()))
    }

    @Test
    fun assignmentForDrop_hitDifferentCategory_returnsIt() {
        assertEquals("Reminders", categoryAssignmentForDrop(Offset(50f, 20f), targets, current = "Receipts"))
    }

    @Test
    fun assignmentForDrop_hitSameCategory_isNoOp() {
        assertNull(categoryAssignmentForDrop(Offset(50f, 20f), targets, current = "Reminders"))
    }

    @Test
    fun assignmentForDrop_currentNull_hitReturnsCategory() {
        assertEquals("Reminders", categoryAssignmentForDrop(Offset(50f, 20f), targets, current = null))
    }

    @Test
    fun assignmentForDrop_missed_returnsNull() {
        assertNull(categoryAssignmentForDrop(Offset(50f, 200f), targets, current = "Receipts"))
    }
}
