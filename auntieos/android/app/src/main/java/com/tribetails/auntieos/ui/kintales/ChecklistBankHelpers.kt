package com.tribetails.auntieos.ui.kintales

import com.tribetails.auntieos.data.model.ChecklistBankItem
import com.tribetails.auntieos.data.model.ChecklistItem

private fun norm(s: String): String = s.trim().lowercase()

/** True when [items] already contains an item with the given text (case/space-insensitive). */
fun checklistHasText(items: List<ChecklistItem>, text: String): Boolean {
    val key = norm(text)
    return items.any { norm(it.text) == key }
}

/**
 * Run-4 #7b: bank items not already in the template's checklist, so the "Add from
 * bank" picker never offers a duplicate. Mirrors the web helper.
 */
fun bankItemsNotInChecklist(bank: List<ChecklistBankItem>, items: List<ChecklistItem>): List<ChecklistBankItem> =
    bank.filterNot { checklistHasText(items, it.text) }

/** Build a template [ChecklistItem] from a picked bank item. Mirrors the web helper. */
fun checklistItemFromBank(bankItem: ChecklistBankItem, key: String, order: Int): ChecklistItem =
    ChecklistItem(
        key = key,
        text = bankItem.text,
        scope = if (bankItem.scope == "PER_VISIT") "PER_VISIT" else "PER_PET",
        order = order,
    )
