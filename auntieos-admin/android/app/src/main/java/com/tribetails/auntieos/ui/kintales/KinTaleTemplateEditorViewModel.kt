package com.tribetails.auntieos.ui.kintales

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.ChecklistBankItem
import com.tribetails.auntieos.data.model.ChecklistItem
import com.tribetails.auntieos.data.model.ChecklistScope
import com.tribetails.auntieos.data.model.KinTaleTemplate
import com.tribetails.auntieos.data.model.MoodOption
import com.tribetails.auntieos.data.model.kinTaleTemplateFieldChanges
import com.tribetails.auntieos.data.model.ReviewBoosterConfig
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.UUID

data class TemplateEditorUiState(
    val isLoading: Boolean = true,
    val template: KinTaleTemplate = KinTaleTemplate(),
    /**
     * The template exactly as Firestore handed it to us, and the baseline every
     * save diffs against. Null means there is no stored document to preserve:
     * a brand-new template, or one the list no longer holds.
     *
     * It advances only after an ACCEPTED save, so a failed write is retried in
     * full rather than quietly reduced to the difference from an edit that never
     * landed. It is never re-read from Firestore either: a re-read would hand
     * back the very concurrent edit the diff exists to preserve.
     */
    val loaded: KinTaleTemplate? = null,
    val isNew: Boolean = false,
    val saveStatus: SaveStatus = SaveStatus.IDLE,
    val isSaving: Boolean = false,
    val isOnlyDefault: Boolean = false,        // true when this template is the only default
    val error: String? = null
)

class KinTaleTemplateEditorViewModel(
    private val repository: AuntieRepository = AuntieOSApp.instance.repository
) : ViewModel() {

    private val _uiState = MutableStateFlow(TemplateEditorUiState())
    val uiState: StateFlow<TemplateEditorUiState> = _uiState.asStateFlow()

    fun load(templateId: String?) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)

            val all = repository.getKinTaleTemplates().getOrDefault(emptyList())
            val isNew = templateId.isNullOrBlank() || templateId == "new"
            // The stored document, or null when there is none to preserve. An
            // id that matches nothing in the collection is NOT a blank template
            // to start editing: saving it would either create a stray document
            // or write over a template we never read. Kept null so `persist`
            // refuses rather than guessing.
            val stored = if (isNew) null else all.firstOrNull { it.id == templateId }
            val template = if (isNew) {
                // New template scaffold
                KinTaleTemplate(
                    name = "New Template",
                    description = "",
                    // Blank, not the old canned line: the message is the story of
                    // the visit, and a default invited sending it unedited (2026-08-17
                    // walk mark 23). Matches the KinTaleTemplate data-class default.
                    defaultEmailMessage = "",
                    isDefault = all.none { it.isDefault },
                    moodOptions = DefaultKinTaleTemplate.template.moodOptions
                )
            } else {
                stored ?: KinTaleTemplate()
            }

            val onlyDefault = template.isDefault && all.count { it.isDefault } <= 1

            _uiState.value = TemplateEditorUiState(
                isLoading = false,
                template = template,
                loaded = stored,
                isNew = isNew,
                isOnlyDefault = onlyDefault,
                error = if (!isNew && stored == null) TEMPLATE_NOT_LOADED else null
            )
        }
    }

    // --- Basic settings ---

    fun updateName(name: String) = mutate { it.copy(name = name) }
    fun updateDescription(d: String) = mutate { it.copy(description = d) }
    fun updateDefaultEmailMessage(msg: String) = mutate { it.copy(defaultEmailMessage = msg) }

    fun toggleIsDefault(isDefault: Boolean) {
        if (_uiState.value.isOnlyDefault && !isDefault) return // can't un-default the only default
        mutate { it.copy(isDefault = isDefault) }
    }

    fun updateServiceTypeKeys(keys: List<String>) = mutate { it.copy(serviceTypeKeys = keys) }

    // The mock's "Active" row. `isActive` was decoded and shown as the Inactive
    // tag on the picker but had no control here; the web editor has one, and a
    // persisted field that one platform can read but not edit is a defect.
    fun toggleIsActive(on: Boolean) = mutate { it.copy(isActive = on) }

    // --- Display section toggles ---

    fun togglePhotoShowcase(on: Boolean)    = mutate { it.copy(photoShowcaseEnabled = on) }
    fun toggleChecklist(on: Boolean)        = mutate { it.copy(checklistEnabled = on) }
    fun togglePetMood(on: Boolean)          = mutate { it.copy(petMoodEnabled = on) }
    fun toggleVisitNotes(on: Boolean)       = mutate { it.copy(visitNotesEnabled = on) }
    fun toggleNextAppointment(on: Boolean)  = mutate { it.copy(nextAppointmentEnabled = on) }
    fun toggleReviewBooster(on: Boolean)    = mutate { it.copy(reviewBoosterEnabled = on) }

    // --- Checklist items ---

    fun addChecklistItem(scope: ChecklistScope) {
        val current = _uiState.value.template.checklistItems
        val newItem = ChecklistItem(
            key = "ck_${UUID.randomUUID().toString().take(8)}",
            text = "",
            scope = scope.name,
            showWhenUnchecked = false,
            order = current.maxOfOrNull { it.order }?.plus(1) ?: 0
        )
        mutate { it.copy(checklistItems = current + newItem) }
    }

    fun updateChecklistItem(updated: ChecklistItem) {
        val list = _uiState.value.template.checklistItems.map {
            if (it.key == updated.key) updated else it
        }
        mutate { it.copy(checklistItems = list) }
    }

    fun removeChecklistItem(key: String) {
        val list = _uiState.value.template.checklistItems.filter { it.key != key }
        mutate { it.copy(checklistItems = list) }
    }

    // --- Run-4 #7b: shared checklist-item bank ---
    private val _bank = MutableStateFlow<List<ChecklistBankItem>>(emptyList())
    val bank: StateFlow<List<ChecklistBankItem>> = _bank.asStateFlow()

    /** Load the bank from the screen (LaunchedEffect), not init, to keep tests isolated. */
    fun loadBank() {
        if (_bank.value.isNotEmpty()) return
        viewModelScope.launch { repository.getChecklistBank().onSuccess { _bank.value = it } }
    }

    /** Append a bank item to the checklist (no duplicate; the picker already filters). */
    fun addFromBank(item: ChecklistBankItem) {
        val current = _uiState.value.template.checklistItems
        val newItem = checklistItemFromBank(
            item,
            key = "ck_${UUID.randomUUID().toString().take(8)}",
            order = current.maxOfOrNull { it.order }?.plus(1) ?: 0,
        )
        mutate { it.copy(checklistItems = current + newItem) }
    }

    /** Persist a custom item to the shared bank, then refresh so the picker reflects it. */
    fun saveItemToBank(text: String, scope: String) {
        if (text.isBlank()) return
        viewModelScope.launch {
            repository.saveChecklistBankItem(text.trim(), scope).onSuccess {
                repository.getChecklistBank().onSuccess { _bank.value = it }
            }
        }
    }

    // --- Mood options ---

    fun addMoodOption() {
        val current = _uiState.value.template.moodOptions
        val newMood = MoodOption(
            key = "mood_${UUID.randomUUID().toString().take(6)}",
            label = "",
            emoji = "😊",
            order = current.maxOfOrNull { it.order }?.plus(1) ?: 0
        )
        mutate { it.copy(moodOptions = current + newMood) }
    }

    fun updateMoodOption(updated: MoodOption) {
        val list = _uiState.value.template.moodOptions.map {
            if (it.key == updated.key) updated else it
        }
        mutate { it.copy(moodOptions = list) }
    }

    fun removeMoodOption(key: String) {
        mutate { it.copy(moodOptions = it.moodOptions.filter { m -> m.key != key }) }
    }

    // --- Review booster config ---

    fun updateReviewBoosterConfig(config: ReviewBoosterConfig) =
        mutate { it.copy(reviewBoosterConfig = config) }

    // --- Persistence ---

    private fun mutate(transform: (KinTaleTemplate) -> KinTaleTemplate) {
        _uiState.value = _uiState.value.copy(template = transform(_uiState.value.template))
    }

    /**
     * Persist template. Called from UI on field blur or section change, so
     * consecutive saves are the norm, not the exception.
     *
     * A CREATE writes the whole model, and must: there is no stored document,
     * so there is nothing to clobber, no sibling-written field to delete, and a
     * new template must not save only the fields that happen to differ from a
     * Kotlin default.
     *
     * An EDIT writes only what changed since [TemplateEditorUiState.loaded],
     * under merge - see `KinTaleTemplateDiff.kt` for what the old whole-model
     * bare `.set()` cost. A save that changed nothing writes nothing and reports
     * success: blurring a field you did not edit is something an operator really
     * does, and the template does hold what they asked for.
     */
    fun persist() {
        val state = _uiState.value
        val template = state.template

        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isSaving = true)
            try {
                if (state.isNew && template.id.isBlank()) {
                    repository.createKinTaleTemplate(template).fold(
                        onSuccess = { newId ->
                            val created = template.copy(id = newId)
                            _uiState.value = _uiState.value.copy(
                                template = created,
                                loaded = created,
                                isNew = false,
                                isSaving = false,
                                saveStatus = SaveStatus.SAVED
                            )
                        },
                        onFailure = { e ->
                            AuntieLog.e("Template create failed", e)
                            _uiState.value = _uiState.value.copy(
                                isSaving = false,
                                saveStatus = SaveStatus.ERROR,
                                error = e.message
                            )
                        }
                    )
                } else {
                    val loaded = state.loaded
                    if (loaded == null) {
                        // Nothing was read, so there is no baseline to diff and no
                        // way to write without guessing at the stored document.
                        AuntieLog.e("Template update refused: no loaded baseline for ${template.id}")
                        _uiState.value = _uiState.value.copy(
                            isSaving = false,
                            saveStatus = SaveStatus.ERROR,
                            error = TEMPLATE_NOT_LOADED
                        )
                        return@launch
                    }
                    val changes = kinTaleTemplateFieldChanges(loaded, template)
                    if (changes.isEmpty()) {
                        _uiState.value = _uiState.value.copy(isSaving = false, saveStatus = SaveStatus.SAVED)
                        return@launch
                    }
                    repository.updateKinTaleTemplateFields(template.id, changes).fold(
                        onSuccess = {
                            // If we just toggled isDefault on, demote any other default templates
                            if (template.isDefault) demoteOtherDefaults(template.id)
                            _uiState.value = _uiState.value.copy(
                                loaded = template,
                                isSaving = false,
                                saveStatus = SaveStatus.SAVED
                            )
                        },
                        onFailure = { e ->
                            AuntieLog.e("Template update failed", e)
                            _uiState.value = _uiState.value.copy(
                                isSaving = false,
                                saveStatus = SaveStatus.ERROR,
                                error = e.message
                            )
                        }
                    )
                }
            } catch (e: Exception) {
                AuntieLog.e("Template persist crashed", e)
                _uiState.value = _uiState.value.copy(isSaving = false, saveStatus = SaveStatus.ERROR)
            }
        }
    }

    /**
     * Ensure only one template is marked default.
     *
     * ONE FIELD, on a template the operator never opened. The React admin does
     * exactly this - `batch.update(ref, { isDefault: false })` - and this used to
     * write the whole sibling model back instead, which both reverted whatever
     * had changed on it since the read and, when that read was stale, could
     * re-assert a second `isDefault: true`. Which of two defaults wins is
     * whatever order the snapshot arrived in, so that ambiguity is exactly what
     * the flag exists to resolve.
     */
    private suspend fun demoteOtherDefaults(keepId: String) {
        val all = repository.getKinTaleTemplates().getOrDefault(emptyList())
        all.filter { it.isDefault && it.id != keepId }.forEach { other ->
            repository.updateKinTaleTemplateFields(other.id, mapOf("isDefault" to false))
        }
    }

    fun delete() {
        val template = _uiState.value.template
        if (template.id.isBlank()) return
        viewModelScope.launch {
            repository.deleteKinTaleTemplate(template.id).getOrNull()
        }
    }

    fun clearError() {
        _uiState.value = _uiState.value.copy(error = null)
    }

    private companion object {
        /**
         * Named for what the operator is looking at - a list of template names -
         * rather than for the document id, which names nothing on their screen.
         */
        const val TEMPLATE_NOT_LOADED =
            "This template is no longer loaded. Reopen it from the template list before saving."
    }
}
