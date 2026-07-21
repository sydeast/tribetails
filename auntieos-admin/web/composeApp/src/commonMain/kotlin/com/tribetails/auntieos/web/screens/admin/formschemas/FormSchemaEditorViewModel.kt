package com.tribetails.auntieos.web.screens.admin.formschemas

import com.tribetails.auntieos.web.data.FormFieldSpec
import com.tribetails.auntieos.web.data.FormSchema
import com.tribetails.auntieos.web.data.FormSchemaRepository
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

/**
 * Status of the most recent save / delete attempt. Surfaces back to the UI so
 * it can render a toast (success or fail-loud error per project policy).
 */
sealed class SaveStatus {
    object Idle    : SaveStatus()
    object Saving  : SaveStatus()
    data class Success(val message: String) : SaveStatus()
    data class Error(val message: String)   : SaveStatus()
}

/**
 * Create-mode is reached either with a blank id (list screen passes "") or the
 * literal "new" sentinel. Both seed an empty schema rather than fetching one.
 */
const val FORM_SCHEMA_NEW_SENTINEL: String = "new"

/** True when [schemaId] means "create a fresh schema" rather than "edit id". */
fun isCreateMode(schemaId: String): Boolean =
    schemaId.isBlank() || schemaId.equals(FORM_SCHEMA_NEW_SENTINEL, ignoreCase = true)

/**
 * Holds the in-flight schema being edited + supporting flags. UI re-renders
 * off [EditorState] only. Every mutation flows through the ViewModel methods
 * so the dirty flag stays accurate.
 */
data class EditorState(
    val schema: FormSchema = FormSchema(),
    val isLoading: Boolean = false,
    val isDirty: Boolean = false,
    val saveStatus: SaveStatus = SaveStatus.Idle,
    val validation: FormSchemaValidationReport = FormSchemaValidationReport(emptyMap(), emptyMap()),
) {
    /** Top-level guard so the Save button can be greyed out cleanly. */
    val canSave: Boolean get() = validation.isValid && schema.name.isNotBlank() && schema.id.isNotBlank() && !isLoading
}

/**
 * Editor ViewModel. Wraps [FormSchemaRepository] and exposes a [StateFlow]
 * for the screen to collect. Methods are suspend so the screen can call them
 * inside a launched coroutine; failures land in [SaveStatus.Error] (no silent
 * fallbacks).
 */
class FormSchemaEditorViewModel(
    private val repo: FormSchemaRepository,
) {
    private val _state = MutableStateFlow(EditorState())
    val state: StateFlow<EditorState> = _state.asStateFlow()

    /**
     * Loads an existing schema for editing. Blank id OR the "new" sentinel that
     * the list screen passes for create-mode = seed an empty schema (no fetch).
     */
    suspend fun load(schemaId: String) {
        if (isCreateMode(schemaId)) {
            _state.value = EditorState(schema = FormSchema(), isDirty = false)
            revalidate()
            return
        }
        _state.update { it.copy(isLoading = true, saveStatus = SaveStatus.Idle) }
        when (val r = repo.getSchema(schemaId)) {
            is WriteResult.Ok  -> {
                _state.update { it.copy(schema = r.value, isLoading = false, isDirty = false, saveStatus = SaveStatus.Idle) }
                revalidate()
            }
            is WriteResult.Err -> {
                _state.update {
                    it.copy(
                        isLoading = false,
                        saveStatus = SaveStatus.Error("Load failed: ${r.message}"),
                    )
                }
            }
        }
    }

    fun updateName(name: String) = mutate { it.copy(name = name) }
    fun updateDescription(desc: String) = mutate { it.copy(description = desc.ifBlank { null }) }
    fun updateId(id: String) = mutate { it.copy(id = id.trim()) }
    fun updateAppliesTo(appliesTo: String) = mutate { it.copy(appliesTo = appliesTo) }

    fun addNewSection() = mutate { addSection(it) }
    fun deleteSection(sectionIdx: Int) = mutate { removeSection(it, sectionIdx) }
    fun bumpSectionUp(sectionIdx: Int) = mutate { moveSectionUp(it, sectionIdx) }
    fun bumpSectionDown(sectionIdx: Int) = mutate { moveSectionDown(it, sectionIdx) }
    fun updateSectionTitle(sectionIdx: Int, title: String) =
        mutate { updateSection(it, sectionIdx) { s -> s.copy(title = title) } }
    fun updateSectionDescription(sectionIdx: Int, desc: String) =
        mutate { updateSection(it, sectionIdx) { s -> s.copy(description = desc.ifBlank { null }) } }

    fun addNewField(sectionIdx: Int) = mutate { addField(it, sectionIdx) }
    fun deleteField(sectionIdx: Int, fieldIdx: Int) = mutate { removeField(it, sectionIdx, fieldIdx) }
    fun bumpFieldUp(sectionIdx: Int, fieldIdx: Int) = mutate { moveFieldUp(it, sectionIdx, fieldIdx) }
    fun bumpFieldDown(sectionIdx: Int, fieldIdx: Int) = mutate { moveFieldDown(it, sectionIdx, fieldIdx) }

    fun mutateField(sectionIdx: Int, fieldIdx: Int, transform: (FormFieldSpec) -> FormFieldSpec) {
        mutate { updateField(it, sectionIdx, fieldIdx, transform) }
    }

    fun updateFieldKey(s: Int, f: Int, key: String) = mutateField(s, f) { it.copy(key = key.trim()) }
    fun updateFieldLabel(s: Int, f: Int, label: String) = mutateField(s, f) { it.copy(label = label) }
    fun updateFieldType(s: Int, f: Int, type: String) = mutateField(s, f) {
        // Clear options when type no longer requires them, seed empty list otherwise.
        val opts = if (FormSchema.typeRequiresOptions(type)) (it.options ?: emptyList()) else null
        it.copy(type = type, options = opts)
    }
    fun updateFieldRequired(s: Int, f: Int, required: Boolean) = mutateField(s, f) { it.copy(required = required) }
    fun updateFieldHelperText(s: Int, f: Int, text: String) =
        mutateField(s, f) { it.copy(helperText = text.ifBlank { null }) }
    fun updateFieldPlaceholder(s: Int, f: Int, text: String) =
        mutateField(s, f) { it.copy(placeholder = text.ifBlank { null }) }
    fun updateFieldDefaultValue(s: Int, f: Int, text: String) =
        mutateField(s, f) { it.copy(defaultValue = text.ifBlank { null }) }
    fun updateFieldGroup(s: Int, f: Int, text: String) =
        mutateField(s, f) { it.copy(group = text.ifBlank { null }) }
    fun updateFieldOptionsFromCsv(s: Int, f: Int, csv: String) =
        mutateField(s, f) { spec ->
            val list = csv.split(",").map { it.trim() }.filter { it.isNotEmpty() }
            spec.copy(options = list)
        }

    /** Persist the current schema. No-op when validation fails; UI must show the inline errors. */
    suspend fun save() {
        val snapshot = _state.value
        if (!snapshot.validation.isValid) {
            // Name the failing invariants so the operator does not have to hunt;
            // the inline section/field banners still pin each to its location.
            val detail = snapshot.validation.allErrors.distinct().joinToString(" ")
            _state.update {
                it.copy(
                    saveStatus = SaveStatus.Error(
                        "Fix validation errors before saving. ${detail}".trim(),
                    ),
                )
            }
            return
        }
        _state.update { it.copy(saveStatus = SaveStatus.Saving) }
        when (val r = repo.saveSchema(snapshot.schema)) {
            is WriteResult.Ok  -> _state.update {
                it.copy(
                    schema     = r.value,
                    isDirty    = false,
                    saveStatus = SaveStatus.Success("Saved ${r.value.name} (v${r.value.version})."),
                )
            }
            is WriteResult.Err -> _state.update {
                it.copy(saveStatus = SaveStatus.Error("Save failed: ${r.message}"))
            }
        }
    }

    /** Hard delete via Cloud Function. Caller should confirm with the operator first. */
    suspend fun delete() {
        val id = _state.value.schema.id
        if (id.isBlank()) {
            _state.update { it.copy(saveStatus = SaveStatus.Error("Cannot delete an unsaved schema.")) }
            return
        }
        _state.update { it.copy(saveStatus = SaveStatus.Saving) }
        when (val r = repo.deleteSchema(id)) {
            is WriteResult.Ok  -> _state.update {
                EditorState(saveStatus = SaveStatus.Success("Deleted $id."))
            }
            is WriteResult.Err -> _state.update {
                it.copy(saveStatus = SaveStatus.Error("Delete failed: ${r.message}"))
            }
        }
    }

    fun clearStatus() {
        _state.update { it.copy(saveStatus = SaveStatus.Idle) }
    }

    // ---- internal ----

    private fun mutate(transform: (FormSchema) -> FormSchema) {
        _state.update {
            val newSchema = transform(it.schema)
            it.copy(
                schema     = newSchema,
                isDirty    = it.isDirty || newSchema != it.schema,
                validation = validateFormSchema(newSchema),
                saveStatus = if (it.saveStatus is SaveStatus.Saving) it.saveStatus else SaveStatus.Idle,
            )
        }
    }

    private fun revalidate() {
        _state.update { it.copy(validation = validateFormSchema(it.schema)) }
    }
}
