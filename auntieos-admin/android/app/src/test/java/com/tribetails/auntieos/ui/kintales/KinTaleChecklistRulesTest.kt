package com.tribetails.auntieos.ui.kintales

import com.google.firebase.firestore.FirebaseFirestoreException
import com.tribetails.auntieos.data.model.ChecklistItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #1593 (QA walk 2026-11-05: "an empty checklist item saves"). Android's copy of
 * the rule the Firestore rules enforce on a written checklist, with the same
 * sentences as the React admin and the desktop console.
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
        val p = checklistProblems(listOf(item("a", "Fed"), item("b", "  ", order = 1), item("a", "", scope = "PER_VISIT")))
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
        assertTrue(checklistProblems(n(61)).overLimit)
        assertFalse(checklistProblems(n(61)).isEmpty)
    }

    @Test
    fun `the cap counts both scopes together, as the server does`() {
        assertTrue(checklistProblems(n(30) + n(31).map { it.copy(scope = "PER_VISIT") }).overLimit)
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
        assertEquals(emptySet<String>(), flaggedBlankIds(list, setOf("PER_PET:b"), revealed = false))
        assertEquals(setOf("PER_PET:b"), flaggedBlankIds(list, emptySet(), revealed = false))
        assertEquals(setOf("PER_PET:b"), flaggedBlankIds(list, setOf("PER_PET:b"), revealed = true))
    }

    @Test
    fun `Save is off only while its reason is on screen`() {
        val problems = checklistProblems(listOf(item("a", "")))
        assertNull(checklistSaveBlockedReason(problems, flagged = emptySet()))
        assertEquals(CHECKLIST_ITEM_BLANK, checklistSaveBlockedReason(problems, flagged = setOf("PER_PET:a")))
        assertEquals(CHECKLIST_LIMIT_REACHED, checklistSaveBlockedReason(checklistProblems(n(61)), emptySet()))
        assertNull(checklistSaveBlockedReason(checklistProblems(n(60)), emptySet()))
    }

    @Test
    fun `a rules refusal reads as a sentence, anything else keeps its own message`() {
        val denied = FirebaseFirestoreException(
            "PERMISSION_DENIED: Missing or insufficient permissions.",
            FirebaseFirestoreException.Code.PERMISSION_DENIED,
        )
        assertTrue(isPermissionDenied(denied))
        assertTrue(isPermissionDenied(RuntimeException("wrapped", denied)))
        assertEquals(TEMPLATE_SAVE_REFUSED, templateSaveErrorText(denied))
        assertFalse(isPermissionDenied(RuntimeException("offline")))
        assertEquals("offline", templateSaveErrorText(RuntimeException("offline")))
    }
}
