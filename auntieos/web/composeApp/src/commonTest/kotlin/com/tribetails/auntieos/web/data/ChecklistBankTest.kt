package com.tribetails.auntieos.web.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ChecklistBankTest {

    @Test fun decodesItems() {
        val json = """{"items":[
            {"id":"a","text":"Fresh water","scope":"PER_PET"},
            {"id":"b","text":"Home secured","scope":"PER_VISIT"}
        ]}"""
        val out = decodeChecklistBank(json)
        assertEquals(2, out.size)
        assertEquals("Fresh water", out[0].text)
        assertEquals("PER_VISIT", out[1].scope)
    }

    @Test fun decode_missingItems_isEmpty() {
        assertEquals(emptyList(), decodeChecklistBank("{}"))
    }

    @Test fun bankItemsNotInChecklist_hidesAlreadyAddedByText() {
        val bank = listOf(
            ChecklistBankItem("a", "Fresh water", "PER_PET"),
            ChecklistBankItem("b", "Walk", "PER_PET"),
        )
        val current = listOf(ChecklistItem(key = "k1", text = "fresh water", scope = "PER_PET"))
        val out = bankItemsNotInChecklist(bank, current)
        assertEquals(listOf("Walk"), out.map { it.text })
    }

    @Test fun bankItemsNotInChecklist_keepsAllWhenNoOverlap() {
        val bank = listOf(ChecklistBankItem("a", "Fresh water", "PER_PET"))
        assertEquals(1, bankItemsNotInChecklist(bank, emptyList()).size)
    }

    @Test fun checklistItemFromBank_carriesTextScopeOrderKey() {
        val item = checklistItemFromBank(ChecklistBankItem("a", "Walk", "PER_VISIT"), key = "k9", order = 3)
        assertEquals("Walk", item.text)
        assertEquals("PER_VISIT", item.scope)
        assertEquals("k9", item.key)
        assertEquals(3, item.order)
    }

    @Test fun checklistItemContainsText_isCaseAndSpaceInsensitive() {
        val items = listOf(ChecklistItem(key = "k", text = "  Fresh Water  ", scope = "PER_PET"))
        assertTrue(checklistHasText(items, "fresh water"))
        assertFalse(checklistHasText(items, "walk"))
    }
}
