package com.tribetails.auntieos.web.screens.kintales

import com.tribetails.auntieos.web.data.ChecklistItem

/**
 * #1593 (QA walk 2026-11-05: "an empty checklist item saves"). The rule the
 * Firestore rule `ktChecklistWriteOk` enforces on every write that carries
 * `checklistItems`: every item's text is non-blank, and there are at most 60
 * items across both scopes. The same rule and sentences live in the React admin
 * (`lib/kinTaleTemplateEdit.ts`) and on Android (`ui/kintales/KinTaleChecklistRules.kt`).
 */

/** The most items one template's checklist holds, both scopes together. */
const val MAX_CHECKLIST_ITEMS = 60

/** Beside an item whose text is blank or only spaces. */
const val CHECKLIST_ITEM_BLANK = "Give this checklist item some text, or remove it."

/** Beside Add item once the checklist is full, and on a stored checklist that is over the limit. */
const val CHECKLIST_LIMIT_REACHED = "A checklist holds up to 60 items."

/** A save the Firestore rules refused, in place of the raw 403 / PERMISSION_DENIED text. */
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

/**
 * #1783: whether the save carries the checklist, which is when the Firestore
 * rule `ktChecklistWriteOk` looks at it (a create, or an update whose diff names
 * `checklistItems`). [baseline] is the checklist as loaded, null for a new
 * template. Compared as typed, untrimmed: a stored "  " item the operator never
 * touched is equal to itself, where trimming it to "" would read as an edit.
 * Only when the checklist is in the save do blank items and the 60-item cap
 * hold Save back; otherwise they still show beside the item but a different
 * edit (the title, say) saves.
 */
fun checklistInSave(baseline: List<ChecklistItem>?, edited: List<ChecklistItem>): Boolean =
    baseline == null || baseline != edited
/** Add item (and Add from bank) is offered only while the checklist has room for one more. */
fun canAddChecklistItem(items: List<ChecklistItem>): Boolean = items.size < MAX_CHECKLIST_ITEMS

/** Every item's text with the spaces taken off both ends, as it is written. */
fun trimChecklistItems(items: List<ChecklistItem>): List<ChecklistItem> =
    items.map { if (it.text == it.text.trim()) it else it.copy(text = it.text.trim()) }

/**
 * Which blank items show their message now. An item added this session starts
 * blank, so it waits in [freshIds] until the operator leaves its field; a Save
 * press ([saveRevealed]) shows every one, and an item that was blank when the
 * template loaded is never fresh, so it shows at once.
 */
fun flaggedBlankIds(items: List<ChecklistItem>, freshIds: Set<String>, saveRevealed: Boolean): Set<String> =
    items.filter(::isBlankChecklistItem)
        .map(::checklistItemId)
        .filter { saveRevealed || it !in freshIds }
        .toSet()

/**
 * The sentence beside Save while it is off, or null when Save is on. Save is
 * off only while a reason is on screen: blank items not yet shown leave it on,
 * and pressing it is what shows them.
 */
fun checklistSaveBlockedReason(problems: ChecklistProblems, flagged: Set<String>): String? {
    val reasons = buildList {
        if (flagged.isNotEmpty()) add(CHECKLIST_ITEM_BLANK)
        if (problems.overLimit) add(CHECKLIST_LIMIT_REACHED)
    }
    return if (reasons.isEmpty()) null else reasons.joinToString(" ")
}

/**
 * A Firestore rules refusal. The desktop REST client reports it as
 * `Firestore write 403: {... "status": "PERMISSION_DENIED" ...}`; a callable or
 * SDK path names the code instead.
 */
fun isPermissionDeniedMessage(message: String, code: String? = null): Boolean {
    val c = code?.lowercase().orEmpty()
    if (c == "permission-denied" || c == "permission_denied" || c.endsWith("/permission-denied")) return true
    val m = message.lowercase()
    return "permission_denied" in m ||
        "permission-denied" in m ||
        Regex("""^firestore (write|create) 403\b""").containsMatchIn(m)
}
