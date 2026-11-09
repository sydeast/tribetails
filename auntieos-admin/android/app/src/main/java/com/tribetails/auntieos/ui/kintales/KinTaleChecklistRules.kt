package com.tribetails.auntieos.ui.kintales

import com.google.firebase.firestore.FirebaseFirestoreException
import com.tribetails.auntieos.data.model.ChecklistItem

/**
 * #1593 (QA walk 2026-11-05: "an empty checklist item saves"). The rule the
 * Firestore rule `ktChecklistWriteOk` enforces on every write that carries
 * `checklistItems`: every item's text is non-blank, and there are at most 60
 * items across both scopes. The same rule and sentences live in the React admin
 * (`lib/kinTaleTemplateEdit.ts`) and the desktop console
 * (`screens/kintales/KinTaleChecklistRules.kt`).
 */

/** The most items one template's checklist holds, both scopes together. */
const val MAX_CHECKLIST_ITEMS = 60

/** Beside an item whose text is blank or only spaces. */
const val CHECKLIST_ITEM_BLANK = "Give this checklist item some text, or remove it."

/** Beside Add item once the checklist is full, and on a stored checklist that is over the limit. */
const val CHECKLIST_LIMIT_REACHED = "A checklist holds up to 60 items."

/** A save the Firestore rules refused, in place of "PERMISSION_DENIED: Missing or insufficient permissions." */
const val TEMPLATE_SAVE_REFUSED =
    "The template was not saved. Every checklist item needs text, and a checklist holds up to 60 items."

/** True when the item has no text once spaces are taken off. */
fun isBlankChecklistItem(item: ChecklistItem): Boolean = item.text.isBlank()

/** The identity the editor uses for one item: keys are unique per scope. */
fun checklistItemId(item: ChecklistItem): String = "${item.scope}:${item.key}"

/** What is wrong with a checklist: which items are blank, and whether it is over the limit. */
data class ChecklistProblems(
    /** [checklistItemId] of every blank item, in list order. */
    val blankIds: List<String>,
    val overLimit: Boolean,
) {
    val isEmpty: Boolean get() = blankIds.isEmpty() && !overLimit
}

fun checklistProblems(items: List<ChecklistItem>): ChecklistProblems = ChecklistProblems(
    blankIds = items.filter(::isBlankChecklistItem).map(::checklistItemId),
    overLimit = items.size > MAX_CHECKLIST_ITEMS,
)

/** Add item (and Add from bank) is offered only while the checklist has room for one more. */
fun canAddChecklistItem(items: List<ChecklistItem>): Boolean = items.size < MAX_CHECKLIST_ITEMS

/** Every item's text with the spaces taken off both ends, as it is written. */
fun trimChecklistItems(items: List<ChecklistItem>): List<ChecklistItem> =
    items.map { if (it.text == it.text.trim()) it else it.copy(text = it.text.trim()) }

/**
 * Which blank items show their message now. An item added this session starts
 * blank, so it waits in [freshIds] until the operator leaves its field; a Save
 * or Back press ([revealed]) shows every one, and an item that was blank when
 * the template loaded is never fresh, so it shows at once.
 */
fun flaggedBlankIds(items: List<ChecklistItem>, freshIds: Set<String>, revealed: Boolean): Set<String> =
    items.filter(::isBlankChecklistItem)
        .map(::checklistItemId)
        .filter { revealed || it !in freshIds }
        .toSet()

/**
 * The sentence beside Save Changes while it is off, or null when it is on. It
 * is off only while a reason is on screen: blank items not yet shown leave it
 * on, and pressing it is what shows them.
 */
fun checklistSaveBlockedReason(problems: ChecklistProblems, flagged: Set<String>): String? {
    val reasons = buildList {
        if (flagged.isNotEmpty()) add(CHECKLIST_ITEM_BLANK)
        if (problems.overLimit) add(CHECKLIST_LIMIT_REACHED)
    }
    return if (reasons.isEmpty()) null else reasons.joinToString(" ")
}

/** A Firestore rules refusal: the SDK's PERMISSION_DENIED code, or its text when the cause was wrapped. */
fun isPermissionDenied(e: Throwable?): Boolean {
    var cause = e
    while (cause != null) {
        if (cause is FirebaseFirestoreException &&
            cause.code == FirebaseFirestoreException.Code.PERMISSION_DENIED
        ) return true
        if (cause.message?.contains("PERMISSION_DENIED") == true) return true
        cause = cause.cause.takeIf { it !== cause }
    }
    return false
}

/** What the editor shows for a failed template write. */
fun templateSaveErrorText(e: Throwable): String? =
    if (isPermissionDenied(e)) TEMPLATE_SAVE_REFUSED else e.message
