package com.tribetails.auntieos.ui.admin.formschemas

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.FormSchema
import com.tribetails.auntieos.data.model.FormSchemaAppliesTo
import com.tribetails.auntieos.data.model.FormSchemaField
import com.tribetails.auntieos.data.model.FormSchemaFieldType
import com.tribetails.auntieos.data.model.FormSchemaSection
import com.tribetails.auntieos.data.repository.AuntieRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

enum class SaveStatus { IDLE, SAVING, SAVED, FAILED, VALIDATION_FAILED }

data class FormSchemaEditorState(
    val schemaId: String = "",
    val isNew: Boolean = true,
    val name: String = "",
    val description: String = "",
    val appliesTo: String = FormSchemaAppliesTo.NONE,
    val sections: List<FormSchemaSection> = emptyList(),
    val originalVersion: Int = 0,
    val isLoading: Boolean = false,
    val isDirty: Boolean = false,
    val saveStatus: SaveStatus = SaveStatus.IDLE,
    val validationErrors: List<FormSchemaValidationError> = emptyList(),
    val errorMessage: String? = null,
    val successMessage: String? = null,
)

/**
 * Editor view-model for a single FormSchema. Methods mirror the Web sibling so
 * cross-platform behavior stays aligned ([[full-stack-coverage]]).
 *
 * Errors are surfaced via [errorMessage] which the screen renders through
 * StatusToast per [[fail-loud-policy]] - no silent swallowing.
 */
class FormSchemaEditorViewModel(
    private val repository: AuntieRepository = AuntieOSApp.instance.repository,
) : ViewModel() {

    private val _state = MutableStateFlow(FormSchemaEditorState())
    val state: StateFlow<FormSchemaEditorState> = _state.asStateFlow()

    /** Load an existing schema by id. Empty id = blank-new-schema editor. */
    fun load(schemaId: String?) {
        if (schemaId.isNullOrBlank()) {
            _state.value = FormSchemaEditorState(
                schemaId = "",
                isNew = true,
                sections = listOf(FormSchemaSection(title = "")),
            )
            return
        }
        viewModelScope.launch {
            _state.value = _state.value.copy(isLoading = true, errorMessage = null)
            repository.getFormSchema(schemaId)
                .onSuccess { schema ->
                    if (schema == null) {
                        _state.value = _state.value.copy(
                            isLoading = false,
                            errorMessage = "Schema \"$schemaId\" not found",
                        )
                    } else {
                        _state.value = FormSchemaEditorState(
                            schemaId = schema.id,
                            isNew = false,
                            name = schema.name,
                            description = schema.description,
                            appliesTo = schema.appliesTo,
                            sections = schema.sections,
                            originalVersion = schema.version,
                            isLoading = false,
                        )
                    }
                }
                .onFailure { err ->
                    _state.value = _state.value.copy(
                        isLoading = false,
                        errorMessage = "Failed to load schema: ${err.message ?: err::class.simpleName}",
                    )
                }
        }
    }

    fun updateId(id: String) {
        _state.value = _state.value.copy(schemaId = id, isDirty = true)
    }

    fun updateName(value: String) {
        _state.value = _state.value.copy(name = value, isDirty = true)
    }

    fun updateDescription(value: String) {
        _state.value = _state.value.copy(description = value, isDirty = true)
    }

    fun updateAppliesTo(value: String) {
        _state.value = _state.value.copy(appliesTo = value, isDirty = true)
    }

    fun addSection() {
        val next = _state.value.sections + FormSchemaSection(title = "")
        _state.value = _state.value.copy(sections = next, isDirty = true)
    }

    fun removeSection(index: Int) {
        val current = _state.value.sections
        if (index !in current.indices) return
        _state.value = _state.value.copy(
            sections = current.toMutableList().also { it.removeAt(index) },
            isDirty = true,
        )
    }

    fun moveSection(from: Int, to: Int) {
        _state.value = _state.value.copy(
            sections = FormSchemaReorder.moveSection(_state.value.sections, from, to),
            isDirty = true,
        )
    }

    fun moveSectionUp(index: Int) {
        _state.value = _state.value.copy(
            sections = FormSchemaReorder.moveSectionUp(_state.value.sections, index),
            isDirty = true,
        )
    }

    fun moveSectionDown(index: Int) {
        _state.value = _state.value.copy(
            sections = FormSchemaReorder.moveSectionDown(_state.value.sections, index),
            isDirty = true,
        )
    }

    fun updateSectionTitle(index: Int, value: String) {
        val current = _state.value.sections
        if (index !in current.indices) return
        _state.value = _state.value.copy(
            sections = current.toMutableList().also {
                it[index] = it[index].copy(title = value)
            },
            isDirty = true,
        )
    }

    fun updateSectionDescription(index: Int, value: String?) {
        val current = _state.value.sections
        if (index !in current.indices) return
        _state.value = _state.value.copy(
            sections = current.toMutableList().also {
                it[index] = it[index].copy(description = value?.ifBlank { null })
            },
            isDirty = true,
        )
    }

    fun addField(sectionIndex: Int) {
        val current = _state.value.sections
        if (sectionIndex !in current.indices) return
        _state.value = _state.value.copy(
            sections = current.toMutableList().also {
                val sec = it[sectionIndex]
                it[sectionIndex] = sec.copy(fields = sec.fields + FormSchemaField())
            },
            isDirty = true,
        )
    }

    fun removeField(sectionIndex: Int, fieldIndex: Int) {
        val current = _state.value.sections
        if (sectionIndex !in current.indices) return
        val sec = current[sectionIndex]
        if (fieldIndex !in sec.fields.indices) return
        val newFields = sec.fields.toMutableList().also { it.removeAt(fieldIndex) }
        _state.value = _state.value.copy(
            sections = current.toMutableList().also {
                it[sectionIndex] = sec.copy(fields = newFields)
            },
            isDirty = true,
        )
    }

    fun moveField(sectionIndex: Int, from: Int, to: Int) {
        _state.value = _state.value.copy(
            sections = FormSchemaReorder.moveField(_state.value.sections, sectionIndex, from, to),
            isDirty = true,
        )
    }

    fun moveFieldUp(sectionIndex: Int, fieldIndex: Int) {
        _state.value = _state.value.copy(
            sections = FormSchemaReorder.moveFieldUp(_state.value.sections, sectionIndex, fieldIndex),
            isDirty = true,
        )
    }

    fun moveFieldDown(sectionIndex: Int, fieldIndex: Int) {
        _state.value = _state.value.copy(
            sections = FormSchemaReorder.moveFieldDown(_state.value.sections, sectionIndex, fieldIndex),
            isDirty = true,
        )
    }

    fun updateField(
        sectionIndex: Int,
        fieldIndex: Int,
        transform: (FormSchemaField) -> FormSchemaField,
    ) {
        val current = _state.value.sections
        if (sectionIndex !in current.indices) return
        val sec = current[sectionIndex]
        if (fieldIndex !in sec.fields.indices) return
        val updatedField = transform(sec.fields[fieldIndex])
        val newFields = sec.fields.toMutableList().also { it[fieldIndex] = updatedField }
        _state.value = _state.value.copy(
            sections = current.toMutableList().also {
                it[sectionIndex] = sec.copy(fields = newFields)
            },
            isDirty = true,
        )
    }

    fun updateFieldKey(sectionIndex: Int, fieldIndex: Int, value: String) =
        updateField(sectionIndex, fieldIndex) { it.copy(key = value) }
    fun updateFieldLabel(sectionIndex: Int, fieldIndex: Int, value: String) =
        updateField(sectionIndex, fieldIndex) { it.copy(label = value) }
    fun updateFieldType(sectionIndex: Int, fieldIndex: Int, value: FormSchemaFieldType) =
        updateField(sectionIndex, fieldIndex) { it.copy(type = value.wire) }
    fun updateFieldRequired(sectionIndex: Int, fieldIndex: Int, value: Boolean) =
        updateField(sectionIndex, fieldIndex) { it.copy(required = value) }
    fun updateFieldHelperText(sectionIndex: Int, fieldIndex: Int, value: String?) =
        updateField(sectionIndex, fieldIndex) { it.copy(helperText = value?.ifBlank { null }) }
    fun updateFieldPlaceholder(sectionIndex: Int, fieldIndex: Int, value: String?) =
        updateField(sectionIndex, fieldIndex) { it.copy(placeholder = value?.ifBlank { null }) }
    fun updateFieldOptions(sectionIndex: Int, fieldIndex: Int, optionsText: String) {
        val parsed = optionsText.split("\n", ",")
            .map { it.trim() }
            .filter { it.isNotBlank() }
        updateField(sectionIndex, fieldIndex) { it.copy(options = if (parsed.isEmpty()) null else parsed) }
    }
    fun updateFieldDefaultValue(sectionIndex: Int, fieldIndex: Int, value: String?) =
        updateField(sectionIndex, fieldIndex) { it.copy(defaultValue = value?.ifBlank { null }) }
    fun updateFieldGroup(sectionIndex: Int, fieldIndex: Int, value: String?) =
        updateField(sectionIndex, fieldIndex) { it.copy(group = value?.ifBlank { null }) }

    fun clearTransientMessages() {
        _state.value = _state.value.copy(errorMessage = null, successMessage = null)
    }

    /** Build the current FormSchema snapshot from editor state. */
    fun snapshot(): FormSchema {
        val s = _state.value
        return FormSchema(
            id          = s.schemaId.trim(),
            name        = s.name.trim(),
            description = s.description.trim(),
            appliesTo   = s.appliesTo,
            version     = s.originalVersion,
            sections    = s.sections,
        )
    }

    fun save() {
        val snap = snapshot()
        val errors = FormSchemaValidator.validate(snap)
        if (errors.isNotEmpty()) {
            _state.value = _state.value.copy(
                validationErrors = errors,
                saveStatus = SaveStatus.VALIDATION_FAILED,
                errorMessage = "Fix ${errors.size} validation error(s) before saving",
            )
            return
        }
        _state.value = _state.value.copy(
            validationErrors = emptyList(),
            saveStatus = SaveStatus.SAVING,
            errorMessage = null,
            successMessage = null,
        )
        viewModelScope.launch {
            repository.saveFormSchema(snap)
                .onSuccess {
                    _state.value = _state.value.copy(
                        saveStatus = SaveStatus.SAVED,
                        isDirty = false,
                        isNew = false,
                        successMessage = "Schema saved",
                    )
                }
                .onFailure { err ->
                    _state.value = _state.value.copy(
                        saveStatus = SaveStatus.FAILED,
                        errorMessage = "Save failed: ${err.message ?: err::class.simpleName}",
                    )
                }
        }
    }

    fun delete(onDeleted: () -> Unit = {}) {
        val id = _state.value.schemaId
        if (id.isBlank()) return
        viewModelScope.launch {
            _state.value = _state.value.copy(saveStatus = SaveStatus.SAVING, errorMessage = null)
            repository.deleteFormSchema(id)
                .onSuccess {
                    _state.value = _state.value.copy(
                        saveStatus = SaveStatus.IDLE,
                        successMessage = "Schema deleted",
                    )
                    onDeleted()
                }
                .onFailure { err ->
                    _state.value = _state.value.copy(
                        saveStatus = SaveStatus.FAILED,
                        errorMessage = "Delete failed: ${err.message ?: err::class.simpleName}",
                    )
                }
        }
    }
}
