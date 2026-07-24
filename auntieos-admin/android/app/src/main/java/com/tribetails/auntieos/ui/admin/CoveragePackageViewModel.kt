package com.tribetails.auntieos.ui.admin

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.CoveragePackageConfig
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.domain.CoverageRules
import com.tribetails.auntieos.domain.Duration
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Loads and saves the Coverage Package Builder config (visit menu + rules), the
 * flat data-class UiState + Kotlin Result idiom used by [AdminSettingsViewModel].
 * The pure schedule/pricing maths lives in `domain/CoveragePackage.kt`; this VM
 * only orchestrates the Firestore round-trip.
 */
data class CoveragePackageUiState(
    val config: CoveragePackageConfig = CoveragePackageConfig(),
    val isLoading: Boolean = false,
    val error: String? = null,
    val saveSuccess: Boolean = false,
)

class CoveragePackageViewModel(
    private val repository: AuntieRepository = AuntieOSApp.instance.repository
) : ViewModel() {

    private val _uiState = MutableStateFlow(CoveragePackageUiState())
    val uiState: StateFlow<CoveragePackageUiState> = _uiState.asStateFlow()

    fun loadConfig() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            repository.getCoveragePackageConfig().fold(
                onSuccess = { config ->
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

    /** Persist the operator-edited menu + rules as one unit. */
    fun saveConfig(durations: List<Duration>, rules: CoverageRules) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(saveSuccess = false)
            val next = _uiState.value.config.copy(durations = durations, rules = rules)
            repository.saveCoveragePackageConfig(next).fold(
                onSuccess = {
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
