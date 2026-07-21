package com.tribetails.auntieos.web.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.data.FormFieldSpec
import com.tribetails.auntieos.web.data.FormSchema
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * Renders one or more dynamic [FormSchema]s as editable inputs bound to a flat
 * `key -> value` map. Field values are stored as strings (the wire format the
 * form_schemas backend uses); multiselect is a comma-joined list and checkbox is
 * "true"/"false". This is the shared renderer behind the KIN precare checklist
 * (spec 06 item 5 / 1C) and any other appliesTo-placed schema.
 *
 * Fail-loud: unknown field types fall back to a plain text field rather than
 * silently dropping the input, so a schema authored with a future type still edits.
 */
@Composable
fun DynamicFormFields(
    schemas: List<FormSchema>,
    values: Map<String, String>,
    onValueChange: (key: String, value: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        schemas.forEach { schema ->
            schema.sections.forEach { section ->
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (section.title.isNotBlank()) {
                        AuntieFieldLabel(text = section.title)
                    }
                    if (!section.description.isNullOrBlank()) {
                        Text(
                            text = section.description!!,
                            style = AuntieTheme.typography.bodySmall,
                            color = AuntieTheme.colors.textDim,
                        )
                    }
                    section.fields.forEach { field ->
                        DynamicField(
                            field = field,
                            value = values[field.key].orEmpty(),
                            onChange = { onValueChange(field.key, it) },
                        )
                    }
                }
            }
        }
    }
}

/**
 * Read-only counterpart to [DynamicFormFields] for a profile / dossier view. Walks the same
 * [FormSchema]s and emits one [row] per field that has a non-blank saved value, so a
 * configured-but-unanswered (or condition-hidden) field stays out of the way. The caller
 * supplies [row] so the values render in the host screen's own label/value style.
 * multiselect CSV is shown comma-spaced; checkbox "true"/"false" reads as Yes/No.
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

/** Returns true when any field across [schemas] has a non-blank value in [values]. Lets a
 *  host screen decide whether to render the custom-fields panel at all. */
fun hasDynamicFieldValues(schemas: List<FormSchema>, values: Map<String, String>): Boolean =
    schemas.any { schema ->
        schema.sections.any { section ->
            section.fields.any { values[it.key].orEmpty().isNotBlank() }
        }
    }

/** Human-readable rendering of a stored field value for read-only display. */
internal fun formatDynamicFieldValue(type: String, raw: String): String = when (type) {
    "checkbox" -> if (raw == "true") "Yes" else "No"
    "multiselect" -> multiSelectValues(raw).joinToString(", ")
    else -> raw
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DynamicField(field: FormFieldSpec, value: String, onChange: (String) -> Unit) {
    val label = field.label + if (field.required) " *" else ""
    when (field.type) {
        "textarea" -> MultilineField(
            value, onChange, label = label, minLines = 2,
            placeholder = field.placeholder.orEmpty(), required = field.required,
            modifier = Modifier.fillMaxWidth(),
        )
        "select" -> AuntieSelectField(
            label = label,
            options = field.options.orEmpty(),
            selected = value,
            onSelect = onChange,
            required = field.required,
            modifier = Modifier.fillMaxWidth(),
        )
        "multiselect" -> MultiSelectChips(
            label = label,
            options = field.options.orEmpty(),
            csv = value,
            onChange = onChange,
        )
        "checkbox" -> AuntieChip(
            label = field.label,
            selected = value == "true",
            onClick = { onChange(if (value == "true") "false" else "true") },
            tone = AuntieChipTone.Teal,
        )
        "number" -> BottomBorderField(
            value, onChange, label = label, keyboardType = KeyboardType.Number,
            placeholder = field.placeholder.orEmpty(), required = field.required,
            modifier = Modifier.fillMaxWidth(),
        )
        "phone" -> BottomBorderField(
            value, onChange, label = label, keyboardType = KeyboardType.Phone,
            placeholder = field.placeholder.orEmpty(), required = field.required,
            modifier = Modifier.fillMaxWidth(),
        )
        "email" -> BottomBorderField(
            value, onChange, label = label, keyboardType = KeyboardType.Email,
            placeholder = field.placeholder.orEmpty(), required = field.required,
            modifier = Modifier.fillMaxWidth(),
        )
        "date" -> BottomBorderField(
            value, onChange, label = label,
            placeholder = field.placeholder.ifNullOrBlank("YYYY-MM-DD"), required = field.required,
            modifier = Modifier.fillMaxWidth(),
        )
        // "text" and any unknown/future type: plain text field (fail-loud, never dropped).
        else -> BottomBorderField(
            value, onChange, label = label,
            placeholder = field.placeholder.orEmpty(), required = field.required,
            modifier = Modifier.fillMaxWidth(),
        )
    }
    if (!field.helperText.isNullOrBlank()) {
        Spacer(Modifier.height(4.dp))
        Text(
            text = field.helperText!!,
            style = AuntieTheme.typography.bodySmall,
            color = AuntieTheme.colors.textFaint,
        )
    }
}

/** Comma-joined multiselect rendered as toggleable chips. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun MultiSelectChips(
    label: String,
    options: List<String>,
    csv: String,
    onChange: (String) -> Unit,
) {
    val selected = multiSelectValues(csv)
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        AuntieFieldLabel(text = label)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            options.forEach { opt ->
                AuntieChip(
                    label = opt,
                    selected = opt in selected,
                    onClick = { onChange(toggleMultiSelect(csv, opt)) },
                    tone = AuntieChipTone.Teal,
                )
            }
        }
    }
}

private fun String?.ifNullOrBlank(fallback: String): String =
    if (this.isNullOrBlank()) fallback else this

/** Parse a comma-joined multiselect value into its trimmed, non-blank members. */
internal fun multiSelectValues(csv: String): List<String> =
    csv.split(",").map { it.trim() }.filter { it.isNotEmpty() }

/** Toggle [option] in a comma-joined multiselect value, preserving order. */
internal fun toggleMultiSelect(csv: String, option: String): String {
    val current = multiSelectValues(csv).toMutableList()
    if (option in current) current.remove(option) else current.add(option)
    return current.joinToString(",")
}
