package com.tribetails.auntieos.web.screens.admin

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * Pins the pure hit-test for drag-drop category assignment on the Template Bank.
 * The gesture/visual glue is platform foundation code; this is the logic that
 * decides which category chip a release lands on and whether it should persist.
 * Mirrored on Android so both platforms assign identically.
 */
class TemplateCategoryDragTest {

    // Two side-by-side category chips. "All" is deliberately NOT a drop target.
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
        assertNull(categoryDropTarget(Offset(50f, 200f), targets)) // below the row
        assertNull(categoryDropTarget(Offset(105f, 20f), targets)) // in the gap between chips
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
