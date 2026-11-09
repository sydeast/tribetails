package com.tribetails.auntieos.web.screens.kintales

import com.tribetails.auntieos.web.data.ChecklistItem
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * #1593 (QA walk 2026-11-05: "an empty checklist item saves"). The desktop
 * console's copy of the rule the Firestore rules enforce on a written checklist,
 * with the same sentences as the React admin and Android.
 */
class KinTaleChecklistRulesTest {

    private fun item(key: String, text: String, scope: String = "PER_PET", order: Int = 0) =
        ChecklistItem(key = key, text = text, scope = scope, order = order)

    private fun n(count: Int) = List(count) { i -> item("item_${i + 1}", "Item ${i + 1}", order = i) }

    @Test
    fun `the sentences are word for word the ones the other clients show`() {
        assertEquals("Give this checklist item some text, or remove it.", CHECKLIST_ITEM_BLANK)
        assertEquals("A checklist holds up to 60 items.", CHECKLIST_LIMIT_REACHED)
        assertEquals(60, MAX_CHECKLIST_ITEMS)
    }

    @Test
    fun `an empty item is blank`() {
        assertTrue(isBlankChecklistItem(item("a", "")))
    }

    @Test
    fun `an item of only spaces, tabs or newlines is blank`() {
        assertTrue(isBlankChecklistItem(item("a", "   ")))
        assertTrue(isBlankChecklistItem(item("a", "\t\n ")))
        assertFalse(isBlankChecklistItem(item("a", " Fed ")))
    }

    @Test
    fun `names every blank item by scope and key, in list order`() {
        val list = listOf(
            item("a", "Fed"),
            item("b", "  ", order = 1),
            item("a", "", scope = "PER_VISIT"),
        )
        val p = checklistProblems(list)
        assertEquals(listOf("PER_PET:b", "PER_VISIT:a"), p.blankIds)
        assertFalse(p.overLimit)
        assertFalse(p.isEmpty)
    }

    @Test
    fun `60 items is allowed and full`() {
        assertTrue(checklistProblems(n(60)).isEmpty)
        assertTrue(canAddChecklistItem(n(59)))
        assertFalse(canAddChecklistItem(n(60)))
    }

    @Test
    fun `61 items is over the limit`() {
        val p = checklistProblems(n(61))
        assertTrue(p.overLimit)
        assertFalse(p.isEmpty)
    }

    @Test
    fun `the cap counts both scopes together, as the server does`() {
        val mixed = n(30) + n(31).map { it.copy(scope = "PER_VISIT") }
        assertTrue(checklistProblems(mixed).overLimit)
    }

    @Test
    fun `trims each item text and leaves a clean item as it was`() {
        val clean = item("a", "Fed")
        val out = trimChecklistItems(listOf(clean, item("b", "  Walked \n", order = 1)))
        assertEquals(listOf("Fed", "Walked"), out.map { it.text })
        assertSame(clean, out[0])
    }

    @Test
    fun `a freshly added blank item waits until it is left or Save is pressed`() {
        val list = listOf(item("a", "Fed"), item("b", ""))
        val fresh = setOf("PER_PET:b")
        assertEquals(emptySet(), flaggedBlankIds(list, fresh, saveRevealed = false))
        assertEquals(setOf("PER_PET:b"), flaggedBlankIds(list, emptySet(), saveRevealed = false))
        assertEquals(setOf("PER_PET:b"), flaggedBlankIds(list, fresh, saveRevealed = true))
    }

    @Test
    fun `Save is off only while its reason is on screen`() {
        val list = listOf(item("a", ""))
        val problems = checklistProblems(list)
        // Not yet shown: Save stays on, and pressing it is what shows the message.
        assertNull(checklistSaveBlockedReason(problems, flagged = emptySet()))
        assertEquals(CHECKLIST_ITEM_BLANK, checklistSaveBlockedReason(problems, flagged = setOf("PER_PET:a")))
        assertEquals(CHECKLIST_LIMIT_REACHED, checklistSaveBlockedReason(checklistProblems(n(61)), emptySet()))
        assertNull(checklistSaveBlockedReason(checklistProblems(n(60)), emptySet()))
    }

    @Test
    fun `knows a rules refusal from the REST 403 text or a code, and nothing else`() {
        assertTrue(
            isPermissionDeniedMessage(
                """Firestore write 403: { "error": { "code": 403, "message": "Missing or insufficient permissions.", "status": "PERMISSION_DENIED" } }""",
            ),
        )
        assertTrue(isPermissionDeniedMessage("Firestore create 403: {}"))
        assertTrue(isPermissionDeniedMessage("anything", code = "permission-denied"))
        assertFalse(isPermissionDeniedMessage("Firestore write 503: unavailable"))
        assertFalse(isPermissionDeniedMessage("offline"))
    }

    // ── #1783: the checklist gates Save only when the save carries it ────────
    @Test
    fun `a new template always carries its checklist`() {
        assertTrue(checklistInSave(null, listOf(item("a", "Meds"))))
    }
    @Test
    fun `an untouched checklist with a stored blank item is not in the save`() {
        val stored = listOf(item("a", "Meds"), item("b", "  ", order = 1))
        // Still reported as a problem, so its sentence shows beside the item...
        assertEquals(listOf("PER_PET:b"), checklistProblems(stored).blankIds)
        // ...but a title-only edit leaves the checklist alone, so it does not gate Save.
        assertFalse(checklistInSave(stored, stored.toList()))
        assertNull(checklistSaveBlockedReason(checklistProblems(stored), emptySet()).takeIf { checklistInSave(stored, stored) })
    }
    @Test
    fun `changing the checklist with a blank item still in it is in the save and is refused`() {
        val stored = listOf(item("a", "Meds"), item("b", "  ", order = 1))
        val edited = listOf(item("a", "Meds and water"), item("b", "  ", order = 1))
        assertTrue(checklistInSave(stored, edited))
        assertFalse(checklistProblems(edited).isEmpty)
        assertEquals(
            CHECKLIST_ITEM_BLANK,
            checklistSaveBlockedReason(checklistProblems(edited), flaggedBlankIds(edited, emptySet(), false)),
        )
    }
    @Test
    fun `filling the blank item in is a checklist change that passes`() {
        val stored = listOf(item("a", "Meds"), item("b", "", order = 1))
        val edited = listOf(item("a", "Meds"), item("b", "Fed", order = 1))
        assertTrue(checklistInSave(stored, edited))
        assertTrue(checklistProblems(edited).isEmpty)
    }
    @Test
    fun `a checklist over the cap that was not touched is not in the save`() {
        val stored = n(61)
        assertTrue(checklistProblems(stored).overLimit)
        assertFalse(checklistInSave(stored, stored))
    }
}
