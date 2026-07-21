package com.tribetails.auntieos.ui.admin.formschemas

import com.tribetails.auntieos.data.model.FormSchemaField
import com.tribetails.auntieos.data.model.FormSchemaFieldType
import com.tribetails.auntieos.data.model.FormSchemaSection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-helper tests for the live-preview mapper (editor state -> DynamicFormFields
 * inputs). Covers every supported field type, the unknown-type fallback, blank-label
 * normalization, default/checkbox seeding, and the non-persisting re-seed contract.
 * Compose-free per [[compose-pure-helper-tdd]].
 */
class FormSchemaPreviewMapperTest {

    private fun field(
        key: String = "k",
        label: String = "Label",
        type: String = FormSchemaFieldType.TEXT.wire,
        default: String? = null,
    ) = FormSchemaField(key = key, label = label, type = type, defaultValue = default)

    private fun section(vararg fields: FormSchemaField) =
        FormSchemaSection(title = "Sec", fields = fields.toList())

    // ── type reconciliation: every supported type is passed through verbatim ──
    @Test fun previewSchema_preservesEverySupportedType() {
        val fields = FormSchemaFieldType.entries.mapIndexed { i, t ->
            field(key = "f$i", label = t.displayLabel, type = t.wire)
        }
        val out = FormSchemaPreviewMapper.previewSchema(listOf(FormSchemaSection(title = "T", fields = fields)))
        val outTypes = out.sections.single().fields.map { it.type }
        assertEquals(FormSchemaFieldType.allWire, outTypes)
    }

    @Test fun previewSchema_keepsOptionsForSelectTypes() {
        val f = FormSchemaField(
            key = "size", label = "Size", type = FormSchemaFieldType.SELECT.wire,
            options = listOf("S", "M", "L"),
        )
        val out = FormSchemaPreviewMapper.previewSchema(listOf(section(f)))
        assertEquals(listOf("S", "M", "L"), out.sections.single().fields.single().options)
    }

    // ── unknown type: never hidden, never crashes, shown labeled ──
    @Test fun previewSchema_unknownType_isKeptAndLabeled() {
        val f = field(key = "weird", label = "Weird One", type = "color-picker-9000")
        val out = FormSchemaPreviewMapper.previewSchema(listOf(section(f)))
        val mapped = out.sections.single().fields.single()
        assertEquals("color-picker-9000", mapped.type) // passed through verbatim
        assertEquals("Weird One", mapped.label)         // shown labeled, not dropped
    }

    @Test fun previewValues_unknownType_seedsBlank() {
        val f = field(key = "weird", type = "color-picker-9000")
        val values = FormSchemaPreviewMapper.previewValues(listOf(section(f)))
        assertEquals("", values["weird"])
    }

    // ── blank-label normalization (never renders blank) ──
    @Test fun previewLabel_blankLabel_fallsBackToKey() {
        val f = field(key = "petName", label = "")
        assertEquals("petName", FormSchemaPreviewMapper.previewLabel(f, 3))
    }

    @Test fun previewLabel_blankLabelAndKey_fallsBackToPositional() {
        val f = field(key = "", label = "")
        assertEquals("Field 3", FormSchemaPreviewMapper.previewLabel(f, 2))
    }

    @Test fun previewLabel_realLabel_isKept() {
        val f = field(key = "k", label = "Real Label")
        assertEquals("Real Label", FormSchemaPreviewMapper.previewLabel(f, 0))
    }

    @Test fun previewSchema_blankLabelField_isNormalizedNotDropped() {
        val out = FormSchemaPreviewMapper.previewSchema(listOf(section(field(key = "myKey", label = ""))))
        assertEquals("myKey", out.sections.single().fields.single().label)
    }

    // ── value seeding ──
    @Test fun previewValues_textWithNoDefault_seedsBlank() {
        val values = FormSchemaPreviewMapper.previewValues(listOf(section(field(key = "name"))))
        assertEquals("", values["name"])
    }

    @Test fun previewValues_defaultValue_seedsField() {
        val f = field(key = "name", type = FormSchemaFieldType.TEXT.wire, default = "Rex")
        val values = FormSchemaPreviewMapper.previewValues(listOf(section(f)))
        assertEquals("Rex", values["name"])
    }

    @Test fun previewValues_checkboxWithNoDefault_seedsFalse() {
        val f = field(key = "agree", type = FormSchemaFieldType.CHECKBOX.wire)
        val values = FormSchemaPreviewMapper.previewValues(listOf(section(f)))
        assertEquals("false", values["agree"])
    }

    @Test fun previewValues_checkboxWithDefault_usesDefault() {
        val f = field(key = "agree", type = FormSchemaFieldType.CHECKBOX.wire, default = "true")
        val values = FormSchemaPreviewMapper.previewValues(listOf(section(f)))
        assertEquals("true", values["agree"])
    }

    @Test fun previewValues_numberDateEmailPhone_seedBlankWhenNoDefault() {
        val fields = section(
            field(key = "n", type = FormSchemaFieldType.NUMBER.wire),
            field(key = "d", type = FormSchemaFieldType.DATE.wire),
            field(key = "e", type = FormSchemaFieldType.EMAIL.wire),
            field(key = "p", type = FormSchemaFieldType.PHONE.wire),
        )
        val values = FormSchemaPreviewMapper.previewValues(listOf(fields))
        assertEquals("", values["n"])
        assertEquals("", values["d"])
        assertEquals("", values["e"])
        assertEquals("", values["p"])
    }

    @Test fun previewValues_blankKey_isSkipped() {
        val f = field(key = "", label = "Anon")
        val values = FormSchemaPreviewMapper.previewValues(listOf(section(f)))
        assertTrue(values.isEmpty())
    }

    @Test fun previewValues_spansAllSections() {
        val a = FormSchemaSection(title = "A", fields = listOf(field(key = "a")))
        val b = FormSchemaSection(title = "B", fields = listOf(field(key = "b", default = "x")))
        val values = FormSchemaPreviewMapper.previewValues(listOf(a, b))
        assertEquals(setOf("a", "b"), values.keys)
        assertEquals("x", values["b"])
    }

    // ── renderable gate ──
    @Test fun hasRenderableFields_emptySections_false() {
        assertFalse(FormSchemaPreviewMapper.hasRenderableFields(emptyList()))
        assertFalse(FormSchemaPreviewMapper.hasRenderableFields(listOf(FormSchemaSection(title = "T"))))
    }

    @Test fun hasRenderableFields_anyField_true() {
        assertTrue(FormSchemaPreviewMapper.hasRenderableFields(listOf(section(field()))))
    }

    @Test fun previewSchema_carriesNameAndDescription() {
        val out = FormSchemaPreviewMapper.previewSchema(emptyList(), name = "Tribe Profile", description = "desc")
        assertEquals("Tribe Profile", out.name)
        assertEquals("desc", out.description)
    }
}
