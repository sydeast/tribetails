package com.tribetails.auntieos.web.data

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Pure-helper test for the shared form_schema placement filter (Phase 14). Every
 * dynamic-fields consumer screen (KIN, KINFOLK, SESSION, BOOKING, KINTALE) routes
 * through [appliesToSchemaIds], so one test pins the contract for all of them.
 */
class AppliesToSchemaIdsTest {

    private val summaries = listOf(
        FormSchemaSummary(id = "k1", appliesTo = "KIN"),
        FormSchemaSummary(id = "f1", appliesTo = "KINFOLK"),
        FormSchemaSummary(id = "f2", appliesTo = "kinfolk"), // case-insensitive
        FormSchemaSummary(id = "s1", appliesTo = "SESSION"),
        FormSchemaSummary(id = "b1", appliesTo = "BOOKING"),
        FormSchemaSummary(id = "t1", appliesTo = "KINTALE"),
        FormSchemaSummary(id = "n1", appliesTo = "NONE"),
    )

    @Test
    fun filtersByTargetCaseInsensitively() {
        assertEquals(listOf("k1"), appliesToSchemaIds(summaries, "KIN"))
        assertEquals(listOf("f1", "f2"), appliesToSchemaIds(summaries, "KINFOLK"))
        assertEquals(listOf("s1"), appliesToSchemaIds(summaries, "SESSION"))
        assertEquals(listOf("b1"), appliesToSchemaIds(summaries, "BOOKING"))
        assertEquals(listOf("t1"), appliesToSchemaIds(summaries, "kintale")) // lower target
    }

    @Test
    fun emptyWhenNoMatch() {
        assertEquals(emptyList(), appliesToSchemaIds(summaries, "PLANET"))
    }
}
