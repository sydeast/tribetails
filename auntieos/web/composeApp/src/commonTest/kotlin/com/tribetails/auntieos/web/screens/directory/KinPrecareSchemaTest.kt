package com.tribetails.auntieos.web.screens.directory

import com.tribetails.auntieos.web.data.FormSchemaSummary
import kotlin.test.Test
import kotlin.test.assertEquals

/** Pure-helper test for KIN form_schema placement filtering (spec 06 item 5 / 1C). */
class KinPrecareSchemaTest {

    @Test
    fun keepsOnlyKinPlacedSchemas() {
        val summaries = listOf(
            FormSchemaSummary(id = "k1", appliesTo = "KIN"),
            FormSchemaSummary(id = "f1", appliesTo = "KINFOLK"),
            FormSchemaSummary(id = "k2", appliesTo = "kin"), // case-insensitive
            FormSchemaSummary(id = "n1", appliesTo = "NONE"),
        )
        assertEquals(listOf("k1", "k2"), kinSchemaIds(summaries))
    }

    @Test
    fun emptyWhenNoKinSchemas() {
        val summaries = listOf(FormSchemaSummary(id = "f1", appliesTo = "KINFOLK"))
        assertEquals(emptyList(), kinSchemaIds(summaries))
    }
}
