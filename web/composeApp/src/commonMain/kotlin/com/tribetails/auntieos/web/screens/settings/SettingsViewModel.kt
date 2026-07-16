package com.tribetails.auntieos.web.screens.settings

import androidx.compose.runtime.Stable
import com.tribetails.auntieos.web.data.AuntieDataSource
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.VetClinic
import com.tribetails.auntieos.web.data.WriteResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

@Stable
data class SettingsUiState(
    val settingsResult: FirestoreResult<BusinessSettings> = FirestoreResult.Loading,
    val saveSuccess: Boolean = false,
    val saveError: String? = null,
)

class SettingsViewModel(private val dataSource: AuntieDataSource) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    private val _uiState = MutableStateFlow(SettingsUiState())
    val uiState: StateFlow<SettingsUiState> = _uiState.asStateFlow()

    init {
        scope.launch {
            dataSource.businessSettingsStream().collect { result ->
                _uiState.update { it.copy(settingsResult = result) }
            }
        }
    }

    suspend fun saveSettings(settings: BusinessSettings) {
        if (_uiState.value.settingsResult !is FirestoreResult.Data) {
            _uiState.update { it.copy(saveSuccess = false, saveError = "Cannot save: settings not yet loaded") }
            return
        }
        when (val r = dataSource.saveBusinessSettings(settings)) {
            is WriteResult.Ok  -> _uiState.update { it.copy(saveSuccess = true, saveError = null) }
            is WriteResult.Err -> _uiState.update { it.copy(saveSuccess = false, saveError = "Save failed: ${r.message}") }
        }
    }

    fun clearSaveSuccess() { _uiState.update { it.copy(saveSuccess = false) } }
    fun clearSaveError()   { _uiState.update { it.copy(saveError = null) } }

    // ── Vet clinics (spec 29 item 8): shared vet_clinics catalog, full CRUD.
    fun vetClinicsStream(): Flow<FirestoreResult<List<VetClinic>>> = dataSource.vetClinicsStream()

    // Suspend delegations (return the raw result; used for unit/integration tests).
    suspend fun createVetClinic(clinic: VetClinic): WriteResult<String> = dataSource.createVetClinic(clinic)
    suspend fun updateVetClinic(clinic: VetClinic): WriteResult<Unit> = dataSource.updateVetClinic(clinic)
    suspend fun deleteVetClinic(id: String): WriteResult<Unit> = dataSource.deleteVetClinic(id)

    // Fail-loud write actions for the UI: each launches on the VM scope and pushes
    // a human message to [vetClinicError] on failure (never silently swallowed).
    private val _vetClinicError = MutableStateFlow<String?>(null)
    val vetClinicError: StateFlow<String?> = _vetClinicError.asStateFlow()
    fun clearVetClinicError() { _vetClinicError.update { null } }

    private fun report(label: String, result: WriteResult<*>) {
        _vetClinicError.value = if (result is WriteResult.Err) "$label: ${result.message}" else null
    }

    fun addVetClinic(clinic: VetClinic) =
        scope.launch { report("Couldn't add ${clinic.name}", dataSource.createVetClinic(clinic)) }
    fun saveVetClinic(clinic: VetClinic) =
        scope.launch { report("Couldn't save ${clinic.name}", dataSource.updateVetClinic(clinic)) }
    fun removeVetClinic(id: String, name: String) =
        scope.launch { report("Couldn't delete ${name.ifBlank { "clinic" }}", dataSource.deleteVetClinic(id)) }

    /** Approve a kinfolk-submitted pending clinic: flip verified=true (and clear the
     *  submittedBy tag) so it joins the shared bank visible to every household. */
    fun approveVetClinic(clinic: VetClinic) =
        scope.launch { report("Couldn't approve ${clinic.name}", dataSource.updateVetClinic(clinic.copy(verified = true, submittedBy = ""))) }

    /** Reject a pending submission: hard-delete the pending doc (it was never approved). */
    fun rejectVetClinic(id: String, name: String) =
        scope.launch { report("Couldn't reject ${name.ifBlank { "clinic" }}", dataSource.deleteVetClinic(id)) }
}
