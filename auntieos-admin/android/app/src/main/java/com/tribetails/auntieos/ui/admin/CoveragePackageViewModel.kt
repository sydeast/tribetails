package com.tribetails.auntieos.ui.admin

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.CoveragePackageConfig
import com.tribetails.auntieos.data.model.coveragePackageConfigFieldChanges
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.domain.Duration
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Feeds the Coverage Package Builder, the flat data-class UiState + Kotlin Result
 * idiom used by [AdminSettingsViewModel]. The pure schedule/pricing maths lives in
 * `domain/CoveragePackage.kt`; this VM only orchestrates the Firestore reads.
 *
 * [loadSettings] is what the screen calls: since issue #693 the visit menu is the
 * operator's KinCare types on `business_settings`, edited in Settings.
 *
 * [loadConfig] and [saveConfig] read and write `coverage_package_config/config`,
 * the builder's old second rate card. NOTHING ON THE SCREEN CALLS THEM ANY MORE.
 * They are kept, with their write-diff discipline and their tests, because the
 * document still exists and the web writer still exists, and a rate-card write
 * path is not something to delete quietly. Delete them only together with
 * `auntieos-admin/src/api/coveragePackageWrite.ts` and the document itself.
 */
data class CoveragePackageUiState(
    val config: CoveragePackageConfig = CoveragePackageConfig(),
    /** The operator's KinCare types, the source of visit lengths and prices. */
    val businessSettings: BusinessSettings = BusinessSettings(),
    val isLoading: Boolean = false,
    val error: String? = null,
    val saveSuccess: Boolean = false,
)

class CoveragePackageViewModel(
    private val repository: AuntieRepository = AuntieOSApp.instance.repository
) : ViewModel() {

    private val _uiState = MutableStateFlow(CoveragePackageUiState())
    val uiState: StateFlow<CoveragePackageUiState> = _uiState.asStateFlow()

    /**
     * The config document exactly as Firestore handed it over, and the only thing
     * a save is allowed to diff against.
     *
     * NULL UNTIL A LOAD SUCCEEDS, which is load-bearing rather than tidy.
     * [CoveragePackageUiState.config] starts at `CoveragePackageConfig()` - an
     * EMPTY visit menu - and a failed load leaves it there while the screen keeps
     * a working editor beside its error banner. The panel's own "Defaults" button
     * then fills that empty menu with `DEFAULT_DURATIONS` and enables Save, and
     * that save used to write the shipped defaults over the operator's real priced
     * menu, having never read it. No concurrent editor required. [saveConfig]
     * refuses instead. Same find as #327's `EnhancedSchedulingViewModel`.
     *
     * It advances only after a write the server accepted, so a failed save leaves
     * the edit pending and the retry still carries it.
     */
    private var configBaseline: CoveragePackageConfig? = null

    /**
     * Read the KinCare types the builder prices from. Fails loud: an empty menu
     * and a failed read are different states, and the screen must not show the
     * first when it means the second.
     */
    fun loadSettings() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            repository.getBusinessSettings().fold(
                onSuccess = { settings ->
                    _uiState.value = _uiState.value.copy(businessSettings = settings, isLoading = false)
                },
                onFailure = { error ->
                    _uiState.value = _uiState.value.copy(
                        error = "Failed to load your KinCare rates: ${error.message}",
                        isLoading = false,
                    )
                },
            )
        }
    }

    fun loadConfig() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            repository.getCoveragePackageConfig().fold(
                onSuccess = { config ->
                    configBaseline = config
                    _uiState.value = _uiState.value.copy(config = config, isLoading = false)
                },
                onFailure = { error ->
                    _uiState.value = _uiState.value.copy(
                        error = "Failed to load package config: ${error.message}",
                        isLoading = false,
                    )
                },
            )
        }
    }

    /**
     * Persist the operator-edited visit menu as the fields it CHANGES against
     * [configBaseline]. Coverage rules are per-client and are never written to this
     * global doc.
     *
     * `coverage_package_config/config` has a second writer: the React Coverage
     * Package Builder, which patches `{ durations, updatedAt, updatedBy }`
     * (`auntieos-admin/src/api/coveragePackageWrite.ts`). Handing the repository
     * the whole model - which is what this used to do - sent every modelled field
     * back at the value the phone read. `CoveragePackageConfigDiff.kt` says which
     * fields exist, why the blast radius on this document was small, and which two
     * losses the diff actually closes.
     *
     * The edit is applied to the BASELINE rather than to the displayed config, so
     * a save can only ever carry the loaded document plus the menu the operator
     * edited - never a model rebuilt from screen state, the unconditional loss
     * #315 found on the directory screens.
     *
     * NOTHING CHANGED MEANS NOTHING IS WRITTEN, not even the stamp. `updatedAt`
     * says when the document last changed, and moving it for a save that changed
     * nothing makes it lie - and on this shared document that write also put the
     * phone's stale menu over a web edit. The screen still reports success, because
     * "saved" and "nothing to save" are the same outcome to the operator.
     */
    fun saveConfig(durations: List<Duration>) {
        val baseline = configBaseline
        if (baseline == null) {
            _uiState.value = _uiState.value.copy(
                saveSuccess = false,
                error = "Reopen Coverage Packages before saving: its saved visit menu was never loaded.",
            )
            return
        }
        val next = baseline.copy(durations = durations)
        val changes = coveragePackageConfigFieldChanges(baseline, next)
        if (changes.isEmpty()) {
            _uiState.value = _uiState.value.copy(config = next, saveSuccess = true, error = null)
            return
        }
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(saveSuccess = false)
            repository.updateCoveragePackageConfigFields(changes).fold(
                onSuccess = {
                    // The baseline moves to what the server now holds. Without this
                    // a second save re-sends the first save's menu, which is the
                    // same clobber one step later.
                    configBaseline = next
                    _uiState.value = _uiState.value.copy(
                        config = next,
                        saveSuccess = true,
                        error = null,
                    )
                },
                onFailure = { error ->
                    _uiState.value = _uiState.value.copy(
                        error = "Failed to save package config: ${error.message}",
                        saveSuccess = false,
                    )
                },
            )
        }
    }

    fun clearSaveSuccess() {
        _uiState.value = _uiState.value.copy(saveSuccess = false)
    }

    fun clearError() {
        _uiState.value = _uiState.value.copy(error = null)
    }
}
