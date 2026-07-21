package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.FormSchemaSummary
import org.junit.Assert.assertEquals
import org.junit.Test

/** Pure-helper test for KIN form_schema placement filtering (spec 06 item 5 / 1C). */
class KinPrecareSchemaTest {

    @Test
    fun keepsOnlyKinPlacedSchemas() {
        val summaries = listOf(
            FormSchemaSummary(id = "k1", name = "", appliesTo = "KIN", version = 1, updatedAt = "", updatedBy = ""),
            FormSchemaSummary(id = "f1", name = "", appliesTo = "KINFOLK", version = 1, updatedAt = "", updatedBy = ""),
            FormSchemaSummary(id = "k2", name = "", appliesTo = "kin", version = 1, updatedAt = "", updatedBy = ""),
            FormSchemaSummary(id = "n1", name = "", appliesTo = "NONE", version = 1, updatedAt = "", updatedBy = ""),
        )
        assertEquals(listOf("k1", "k2"), kinSchemaIds(summaries))
    }

    @Test
    fun emptyWhenNoKinSchemas() {
        val summaries = listOf(
            FormSchemaSummary(id = "f1", name = "", appliesTo = "KINFOLK", version = 1, updatedAt = "", updatedBy = ""),
        )
        assertEquals(emptyList<String>(), kinSchemaIds(summaries))
    }
}
