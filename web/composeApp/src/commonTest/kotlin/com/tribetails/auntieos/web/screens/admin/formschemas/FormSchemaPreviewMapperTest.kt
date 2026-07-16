package com.tribetails.auntieos.web.screens.admin.formschemas

import com.tribetails.auntieos.web.data.FormFieldSpec
import com.tribetails.auntieos.web.data.FormSchema
import com.tribetails.auntieos.web.data.FormSectionSpec
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * Pure-mapper tests for the FormSchema editor live preview. The mapper turns the
 * in-progress editor [FormSchema] into the render bundle DynamicFormFields consumes
 * (a normalized schema + seed values), reconciling field types and surfacing
 * unknown types fail-loud rather than hiding them.
 */
class FormSchemaPreviewMapperTest {

    private fun schemaOf(vararg fields: FormFieldSpec): FormSchema =
        FormSchema(
            id = "s",
            name = "S",
            sections = listOf(FormSectionSpec(title = "Sec", fields = fields.toList())),
        )

    // ---- each supported type passes through unchanged ----

    @Test
    fun everySupportedTypeIsRenderableAndUnchanged() {
        for (type in FormSchema.SUPPORTED_TYPES) {
            assertTrue(isRenderableFieldType(type), "$type should be renderable")
            val field = FormFieldSpec(key = "k_$type", label = "L $type", type = type)
            val out = reconcilePreviewField(field)
            assertEquals(field, out, "supported type $type must pass through unchanged")
            assertEquals(type, out.type)
            assertEquals("L $type", out.label, "supported type label must not be annotated")
        }
    }

    @Test
    fun mapperPreservesEachSupportedTypeInTheRenderSchema() {
        val fields = FormSchema.SUPPORTED_TYPES.mapIndexed { i, t ->
            FormFieldSpec(key = "k$i", label = "L$i", type = t)
        }
        val model = formSchemaPreviewModel(schemaOf(*fields.toTypedArray()))
        val outTypes = model.schema.sections.single().fields.map { it.type }
        assertEquals(FormSchema.SUPPORTED_TYPES, outTypes)
    }

    // ---- unknown type handling: surfaced labeled, never hidden, never crashes ----

    @Test
    fun unknownTypeIsNotRenderable() {
        assertFalse(isRenderableFieldType("color_picker"))
        assertFalse(isRenderableFieldType("signature"))
        assertFalse(isRenderableFieldType(""))
    }

    @Test
    fun unknownTypeIsRelabeledButNotDroppedAndKeepsItsType() {
        val field = FormFieldSpec(key = "sig", label = "Signature", type = "signature")
        val out = reconcilePreviewField(field)
        // Type is preserved (renderer's else arm draws a plain text input).
        assertEquals("signature", out.type)
        // Label is annotated so the unknown type is loud in the preview.
        assertTrue(out.label.startsWith(UNKNOWN_TYPE_LABEL_PREFIX), "unknown type must be flagged in the label")
        assertTrue(out.label.contains("signature"), "the offending type must appear in the label")
        assertTrue(out.label.endsWith("Signature"), "the original label must be retained")
    }

    @Test
    fun mapperKeepsUnknownFieldInSchemaRatherThanHiding() {
        val model = formSchemaPreviewModel(
            schemaOf(
                FormFieldSpec(key = "a", label = "Known", type = "text"),
                FormFieldSpec(key = "b", label = "Future", type = "rating"),
            )
        )
        val fields = model.schema.sections.single().fields
        assertEquals(2, fields.size, "no field may be dropped from the preview")
        assertEquals("Known", fields[0].label)
        assertTrue(fields[1].label.contains("rating"))
    }

    // ---- seed values ----

    @Test
    fun seedUsesOperatorDefaultValueWhenPresent() {
        val field = FormFieldSpec(key = "size", label = "Size", type = "select", defaultValue = "Medium")
        assertEquals("Medium", previewSeedValue(field))
    }

    @Test
    fun seedIsNullWhenNoDefault() {
        assertEquals(null, previewSeedValue(FormFieldSpec(key = "x", label = "X", type = "text")))
        assertEquals(null, previewSeedValue(FormFieldSpec(key = "x", label = "X", type = "text", defaultValue = "   ")))
    }

    @Test
    fun seedSkipsBlankKeyEvenWithDefault() {
        // A blank key cannot round-trip a value through the renderer's key map.
        assertEquals(null, previewSeedValue(FormFieldSpec(key = "", label = "X", type = "text", defaultValue = "v")))
    }

    @Test
    fun mapperCollectsOnlyKeyedDefaultsIntoValues() {
        val model = formSchemaPreviewModel(
            schemaOf(
                FormFieldSpec(key = "withDefault", label = "A", type = "text", defaultValue = "seed"),
                FormFieldSpec(key = "noDefault", label = "B", type = "text"),
                FormFieldSpec(key = "", label = "C", type = "text", defaultValue = "orphan"),
            )
        )
        assertEquals(mapOf("withDefault" to "seed"), model.values)
    }

    @Test
    fun mapperPreservesSectionTitlesAndDescriptions() {
        val schema = FormSchema(
            id = "s", name = "S",
            sections = listOf(
                FormSectionSpec(title = "Intro", description = "hi", fields = listOf(FormFieldSpec(key = "k", label = "L", type = "text"))),
            ),
        )
        val out = formSchemaPreviewModel(schema).schema.sections.single()
        assertEquals("Intro", out.title)
        assertEquals("hi", out.description)
    }

    @Test
    fun emptySchemaProducesEmptyModel() {
        val model = formSchemaPreviewModel(FormSchema(id = "s", name = "S"))
        assertTrue(model.schema.sections.isEmpty())
        assertTrue(model.values.isEmpty())
    }
}
