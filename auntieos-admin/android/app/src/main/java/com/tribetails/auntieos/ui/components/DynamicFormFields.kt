package com.tribetails.auntieos.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.data.model.FormSchema
import com.tribetails.auntieos.data.model.FormSchemaField
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * Renders one or more dynamic [FormSchema]s as editable inputs bound to a flat
 * `key -> value` map (mirrors the web `DynamicFormFields`). Values are strings:
 * multiselect is comma-joined, checkbox is "true"/"false". Shared renderer behind
 * the KIN precare checklist (spec 06 item 5 / 1C).
 *
 * Fail-loud: an unknown field type falls back to a plain text field rather than
 * silently dropping the input.
 */
@Composable
fun DynamicFormFields(
    schemas: List<FormSchema>,
    values: Map<String, String>,
    onValueChange: (key: String, value: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        schemas.forEach { schema ->
            schema.sections.forEach { section ->
                if (section.title.isNotBlank()) AuntieFieldLabel(text = section.title)
                section.description?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
                }
                section.fields.forEach { field ->
                    DynamicField(field, values[field.key].orEmpty()) { onValueChange(field.key, it) }
                }
            }
        }
    }
}

/**
 * Read-only counterpart to [DynamicFormFields] for a profile / dossier view. Emits one [row]
 * per field that has a non-blank saved value, so a configured-but-unanswered (or
 * condition-hidden) field stays out of the way. Mirrors the web helper of the same name.
 */
@Composable
fun DynamicFormFieldsReadOnly(
    schemas: List<FormSchema>,
    values: Map<String, String>,
    row: @Composable (label: String, value: String) -> Unit,
) {
    schemas.forEach { schema ->
        schema.sections.forEach { section ->
            section.fields.forEach { field ->
                val raw = values[field.key].orEmpty().trim()
                if (raw.isNotBlank()) row(field.label, formatDynamicFieldValue(field.type, raw))
            }
        }
    }
}

/** True when any field across [schemas] has a non-blank value in [values]. */
fun hasDynamicFieldValues(schemas: List<FormSchema>, values: Map<String, String>): Boolean =
    schemas.any { s -> s.sections.any { sec -> sec.fields.any { values[it.key].orEmpty().isNotBlank() } } }

/** Human-readable rendering of a stored field value for read-only display. */
internal fun formatDynamicFieldValue(type: String, raw: String): String = when (type) {
    "checkbox" -> if (raw == "true") "Yes" else "No"
    "multiselect" -> raw.split(",").map { it.trim() }.filter { it.isNotEmpty() }.joinToString(", ")
    else -> raw
}

@Composable
private fun DynamicField(field: FormSchemaField, value: String, onChange: (String) -> Unit) {
    val label = field.label + if (field.required) " *" else ""
    when (field.type) {
        "textarea" -> AuntieField(
            value, onChange, label = label, modifier = Modifier.fillMaxWidth(),
            singleLine = false, minLines = 2, placeholder = field.placeholder.orEmpty(),
        )
        "select" -> AuntieDropdownField(
            value = value.ifBlank { null },
            options = field.options.orEmpty(),
            onSelect = onChange,
            displayText = { it },
            label = label,
            modifier = Modifier.fillMaxWidth(),
            placeholder = field.placeholder ?: "Select…",
        )
        "multiselect" -> MultiSelectChips(label, field.options.orEmpty(), value, onChange)
        "checkbox" -> Row(verticalAlignment = Alignment.CenterVertically) {
            AuntieCheckbox(checked = value == "true", onCheckedChange = { onChange(if (it) "true" else "false") })
            Spacer(Modifier.width(8.dp))
            Text(field.label)
        }
        "number" -> AuntieField(
            value, onChange, label = label, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), placeholder = field.placeholder.orEmpty(),
        )
        "phone" -> AuntieField(
            value, onChange, label = label, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone), placeholder = field.placeholder.orEmpty(),
        )
        "email" -> AuntieField(
            value, onChange, label = label, modifier = Modifier.fillMaxWidth(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email), placeholder = field.placeholder.orEmpty(),
        )
        "date" -> AuntieField(
            value, onChange, label = label, modifier = Modifier.fillMaxWidth(),
            placeholder = field.placeholder ?: "YYYY-MM-DD",
        )
        // "text" and any unknown/future type: plain text field (fail-loud, never dropped).
        else -> AuntieField(
            value, onChange, label = label, modifier = Modifier.fillMaxWidth(),
            placeholder = field.placeholder.orEmpty(),
        )
    }
    field.helperText?.takeIf { it.isNotBlank() }?.let {
        Text(it, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MultiSelectChips(label: String, options: List<String>, csv: String, onChange: (String) -> Unit) {
    val selected = multiSelectValues(csv)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        AuntieFieldLabel(text = label)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            options.forEach { opt ->
                AuntieChip(selected = opt in selected, onClick = { onChange(toggleMultiSelect(csv, opt)) }, label = opt)
            }
        }
    }
}

/** Parse a comma-joined multiselect value into its trimmed, non-blank members. */
internal fun multiSelectValues(csv: String): List<String> =
    csv.split(",").map { it.trim() }.filter { it.isNotEmpty() }

/** Toggle [option] in a comma-joined multiselect value, preserving order. */
internal fun toggleMultiSelect(csv: String, option: String): String {
    val current = multiSelectValues(csv).toMutableList()
    if (option in current) current.remove(option) else current.add(option)
    return current.joinToString(",")
}
