package com.tribetails.auntieos.data.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Drift guard for the `kintale_templates` field contract, plus the diff's own
 * behaviour.
 *
 * Both halves matter and they pull in opposite directions:
 *
 *  - every field [KinTaleTemplate] declares is either written by the differ or
 *    named as server-owned, so ADDING a field to the model without teaching the
 *    differ about it cannot silently stop that field saving; and
 *  - the sibling-written `deleted` flag stays OFF the model, so nobody "fixes"
 *    the resurrection by declaring the field this client has no business
 *    authoring.
 *
 * Same shape as `UserProfileDiffTest` and `BaseServiceDiffTest`.
 */
class KinTaleTemplateDiffTest {

    private fun modelFields(): Set<String> =
        KinTaleTemplate::class.java.declaredFields
            .map { it.name }
            .filterNot { it.startsWith("$") }
            .toSet()

    // ── the contract ──────────────────────────────────────────────────────────

    @Test
    fun `every field on the model is either diffed or named server-owned`() {
        val covered = KINTALE_TEMPLATE_DIFF_FIELDS.keys + KINTALE_TEMPLATE_SERVER_OWNED
        val uncovered = modelFields() - covered
        assertEquals(
            "a new KinTaleTemplate field must join the differ or be named server-owned, " +
                "or the phone silently stops saving it: $uncovered",
            emptySet<String>(),
            uncovered,
        )
    }

    @Test
    fun `the differ names no field the model does not declare`() {
        val stray = KINTALE_TEMPLATE_DIFF_FIELDS.keys - modelFields()
        assertEquals(emptySet<String>(), stray)
    }

    @Test
    fun `the sibling-written soft-delete flag stays off the model`() {
        // If this ever fails the fix went the wrong way. This editor has no
        // delete-state concept, so declaring `deleted` could only write `false`
        // over the desktop admin's `true` - the resurrection, spelled out.
        assertTrue("deleted" !in modelFields())
        assertTrue("deleted" !in KINTALE_TEMPLATE_DIFF_FIELDS.keys)
        // Sanity: the reflection above is reading real fields, not an empty set.
        assertTrue("checklistItems" in modelFields())
        assertTrue("isDefault" in modelFields())
    }

    // ── the diff ──────────────────────────────────────────────────────────────

    @Test
    fun `an untouched template produces no changes`() {
        val loaded = template()
        assertEquals(emptyMap<String, Any?>(), kinTaleTemplateFieldChanges(loaded, loaded.copy()))
    }

    @Test
    fun `renaming writes only the name`() {
        val loaded = template()
        assertEquals(
            mapOf<String, Any?>("name" to "Overnight Recap"),
            kinTaleTemplateFieldChanges(loaded, loaded.copy(name = "Overnight Recap")),
        )
    }

    @Test
    fun `a checklist row edit writes the whole list and nothing else`() {
        val loaded = template()
        val edited = loaded.copy(
            checklistItems = loaded.checklistItems.map {
                if (it.key == "fed") it.copy(text = "Fed breakfast") else it
            },
        )

        val changes = kinTaleTemplateFieldChanges(loaded, edited)

        assertEquals(setOf("checklistItems"), changes.keys)
        @Suppress("UNCHECKED_CAST")
        val written = changes["checklistItems"] as List<ChecklistItem>
        assertEquals("Fed breakfast", written.first { it.key == "fed" }.text)
    }

    /**
     * The field whose deletion this collection already paid for. A `required`
     * toggle has to reach the server as its own change, not ride along on a
     * whole-model replace.
     */
    @Test
    fun `toggling required on a checklist item is a real change`() {
        val loaded = template()
        val edited = loaded.copy(
            checklistItems = loaded.checklistItems.map {
                if (it.key == "meds_given") it.copy(required = true) else it
            },
        )

        val changes = kinTaleTemplateFieldChanges(loaded, edited)
        @Suppress("UNCHECKED_CAST")
        val written = changes["checklistItems"] as List<ChecklistItem>
        assertTrue(written.first { it.key == "meds_given" }.required)
    }

    @Test
    fun `a description cleared by the operator is written as blank`() {
        val loaded = template()
        val changes = kinTaleTemplateFieldChanges(loaded, loaded.copy(description = ""))
        assertEquals(mapOf<String, Any?>("description" to ""), changes)
    }

    @Test
    fun `demoting the default flag is a single-field change`() {
        val loaded = template().copy(isDefault = true)
        assertEquals(
            mapOf<String, Any?>("isDefault" to false),
            kinTaleTemplateFieldChanges(loaded, loaded.copy(isDefault = false)),
        )
    }

    @Test
    fun `the stamps are never part of a diff`() {
        val loaded = template()
        val changes = kinTaleTemplateFieldChanges(
            loaded,
            loaded.copy(createdAt = "2020-01-01T00:00:00", updatedAt = "2020-01-01T00:00:00"),
        )
        assertEquals(emptyMap<String, Any?>(), changes)
    }

    private fun template() = KinTaleTemplate(
        id = "tmpl-1",
        name = "Daily Walk Recap",
        description = "The standard dog-walk recap",
        serviceTypeKeys = listOf("dog_walk"),
        checklistItems = listOf(
            ChecklistItem(key = "fed", text = "Fed", order = 0),
            ChecklistItem(key = "meds_given", text = "Medications given", order = 1),
        ),
        moodOptions = listOf(MoodOption(key = "happy", label = "Happy", emoji = "😊", order = 0)),
        createdAt = "2026-01-01T00:00:00",
        updatedAt = "2026-08-01T00:00:00",
    )
}
