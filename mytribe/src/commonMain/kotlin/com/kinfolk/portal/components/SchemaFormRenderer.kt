package com.kinfolk.portal.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.portal.FormField
import com.kinfolk.portal.portal.FormFieldType
import com.kinfolk.portal.portal.FormSchema
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography

/**
 * Renders an admin-defined FormSchema as a stack of editable fields.
 * Values map: fieldKey -> stringified value.
 */
@Composable
fun SchemaFormRenderer(
    schema: FormSchema,
    values: Map<String, String>,
    onChange: (Map<String, String>) -> Unit,
) {
    val type = LocalKinfolkTypography.current
    Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.l)) {
        schema.sections.forEach { section ->
            Column(
                modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
            ) {
                Text(section.title, style = type.heritageSection)
                if (!section.description.isNullOrBlank()) {
                    Text(section.description, style = type.sansBody)
                }
                GlassCard(
                    modifier = Modifier.fillMaxWidth(),
                    contentPadding = PaddingValues(KinfolkSpacing.l),
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                        section.fields.forEach { field ->
                            SchemaFieldRow(
                                field = field,
                                value = values[field.key].orEmpty(),
                                onValueChange = { v -> onChange(values + (field.key to v)) },
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * #901. The hint text for a schema field, and the ONLY place a schema's
 * `defaultValue` is allowed to appear. Mirrors `schemaPlaceholder` in web
 * `api/tribeApi.ts`.
 *
 * Portal web used to seed an empty field with `defaultValue` as its VALUE while
 * the save sent nothing for a key that was never stored, so the screen and the
 * stored data disagreed. Saving the default instead would write rows the
 * household never typed, freeze today's default into their record, and make the
 * field impossible to empty. A hint is what a default is until someone fills the
 * field in. This side never applied defaults at all, so what it STORES does not
 * change; it now shows the same hint web does.
 */
internal fun schemaPlaceholder(field: FormField): String? =
    listOfNotNull(field.placeholder, field.defaultValue).firstOrNull { it.isNotBlank() }
@Composable
private fun SchemaFieldRow(
    field: FormField,
    value: String,
    onValueChange: (String) -> Unit,
) {
    val type = LocalKinfolkTypography.current
    // #901: the schema's own placeholder, falling back to its default. A checkbox
    // has nowhere to show a hint, so a `defaultValue` of "true" stays unchecked -
    // which is what this client already stored, since it never applied defaults.
    val hint = schemaPlaceholder(field)
    when (field.type) {
        FormFieldType.Text, FormFieldType.Email, FormFieldType.Phone, FormFieldType.Date, FormFieldType.Number -> {
            OutlinedTextField(
                value = value,
                onValueChange = { v ->
                    onValueChange(if (field.type == FormFieldType.Number) v.filter { c -> c.isDigit() || c == '.' } else v)
                },
                label = { Text(if (field.required) "${field.label} *" else field.label) },
                placeholder = hint?.let { { Text(it) } },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            if (!field.helperText.isNullOrBlank()) {
                Text(field.helperText, style = type.sansMeta)
            }
        }
        FormFieldType.Textarea -> {
            OutlinedTextField(
                value = value,
                onValueChange = onValueChange,
                label = { Text(if (field.required) "${field.label} *" else field.label) },
                placeholder = hint?.let { { Text(it) } },
                minLines = 3,
                modifier = Modifier.fillMaxWidth(),
            )
            if (!field.helperText.isNullOrBlank()) {
                Text(field.helperText, style = type.sansMeta)
            }
        }
        FormFieldType.Select -> {
            var open by remember { mutableStateOf(false) }
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(if (field.required) "${field.label} *" else field.label, style = type.sansLabel)
                OutlinedButton(
                    onClick = { open = !open },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text(value.ifBlank { hint ?: "Choose…" }) }
                if (open) {
                    field.options.orEmpty().forEach { opt ->
                        OutlinedButton(
                            onClick = {
                                onValueChange(opt)
                                open = false
                            },
                            modifier = Modifier.fillMaxWidth(),
                        ) { Text(opt) }
                    }
                }
            }
        }
        FormFieldType.MultiSelect -> {
            val current = value.split(",").map { it.trim() }.filter { it.isNotEmpty() }.toMutableSet()
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(if (field.required) "${field.label} *" else field.label, style = type.sansLabel)
                field.options.orEmpty().forEach { opt ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(
                            checked = current.contains(opt),
                            onCheckedChange = { v ->
                                val next = current.toMutableSet()
                                if (v) next.add(opt) else next.remove(opt)
                                onValueChange(next.joinToString(","))
                            },
                            colors = CheckboxDefaults.colors(checkedColor = KinfolkBrand.KinfolkOrange),
                        )
                        Text(opt, style = type.sansBody)
                    }
                }
            }
        }
        FormFieldType.Checkbox -> {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Checkbox(
                    checked = value.equals("true", ignoreCase = true),
                    onCheckedChange = { v -> onValueChange(if (v) "true" else "false") },
                    colors = CheckboxDefaults.colors(checkedColor = KinfolkBrand.KinfolkOrange),
                )
                Text(field.label, style = type.sansBody)
            }
        }
    }
}

