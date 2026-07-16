package com.tribetails.auntieos.ui.kintales

import com.tribetails.auntieos.data.model.ChecklistBankItem
import com.tribetails.auntieos.data.model.ChecklistItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ChecklistBankHelpersTest {

    @Test fun bankItemsNotInChecklist_hidesAlreadyAddedByText() {
        val bank = listOf(
            ChecklistBankItem("a", "Fresh water", "PER_PET"),
            ChecklistBankItem("b", "Walk", "PER_PET"),
        )
        val current = listOf(ChecklistItem(key = "k1", text = "fresh water", scope = "PER_PET"))
        assertEquals(listOf("Walk"), bankItemsNotInChecklist(bank, current).map { it.text })
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

    @Test fun checklistHasText_isCaseAndSpaceInsensitive() {
        val items = listOf(ChecklistItem(key = "k", text = "  Fresh Water  ", scope = "PER_PET"))
        assertTrue(checklistHasText(items, "fresh water"))
        assertFalse(checklistHasText(items, "walk"))
    }
}
