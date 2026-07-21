package com.tribetails.auntieos.ui.admin

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect

/**
 * Pure hit-test for drag-drop category assignment on the Template Bank. Mirrors
 * the web `TemplateCategoryDrag` so a drop assigns the same category on either
 * console. [targets] maps a category label to its on-screen window bounds; the
 * "All" filter chip is excluded by the caller, so a drop there is a no-op.
 */
fun categoryDropTarget(pos: Offset, targets: Map<String, Rect>): String? =
    targets.entries.firstOrNull { it.value.contains(pos) }?.key

/**
 * The category to PERSIST for a drop at [pos], or null for a no-op (the release
 * missed every chip, or landed on the template's current category).
 */
fun categoryAssignmentForDrop(pos: Offset, targets: Map<String, Rect>, current: String?): String? {
    val hit = categoryDropTarget(pos, targets) ?: return null
    return if (hit == (current ?: "")) null else hit
}
