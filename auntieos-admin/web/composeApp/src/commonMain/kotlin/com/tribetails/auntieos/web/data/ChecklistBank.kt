package com.tribetails.auntieos.web.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Run-4 #7b: one item in the shared bank of common KinTale checklist tasks. The bank
 * backs the editor's "Add from bank" picker; admins grow it with "Save to bank".
 */
@Serializable
data class ChecklistBankItem(
    val id: String = "",
    val text: String = "",
    val scope: String = "PER_PET",          // "PER_PET" | "PER_VISIT"
)

private val checklistBankJson = Json { ignoreUnknownKeys = true; isLenient = true }

/** Pure decode of the listChecklistBank body `{items:[{id,text,scope}]}`. */
internal fun decodeChecklistBank(dataJson: String): List<ChecklistBankItem> =
    (checklistBankJson.parseToJsonElement(dataJson).jsonObject["items"] as? JsonArray)
        .orEmpty()
        .mapNotNull { el ->
            val o = el as? JsonObject ?: return@mapNotNull null
            ChecklistBankItem(
                id = o["id"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                text = o["text"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                scope = o["scope"]?.jsonPrimitive?.contentOrNull?.takeIf { it == "PER_VISIT" } ?: "PER_PET",
            )
        }
        .filter { it.text.isNotBlank() }

private fun norm(s: String): String = s.trim().lowercase()

/** True when [items] already contains an item with the given text (case/space-insensitive). */
fun checklistHasText(items: List<ChecklistItem>, text: String): Boolean {
    val key = norm(text)
    return items.any { norm(it.text) == key }
}

/**
 * Bank items not already in the template's checklist, so the picker never offers a
 * duplicate of an item the admin has already added.
 */
fun bankItemsNotInChecklist(bank: List<ChecklistBankItem>, items: List<ChecklistItem>): List<ChecklistBankItem> =
    bank.filterNot { checklistHasText(items, it.text) }

/** Build a template [ChecklistItem] from a picked bank item. */
fun checklistItemFromBank(bankItem: ChecklistBankItem, key: String, order: Int): ChecklistItem =
    ChecklistItem(
        key = key,
        text = bankItem.text,
        scope = if (bankItem.scope == "PER_VISIT") "PER_VISIT" else "PER_PET",
        order = order,
    )
