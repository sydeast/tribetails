package com.tribetails.auntieos.web.screens.settings

import com.tribetails.auntieos.web.observability.reportingExceptionHandler

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
    /** #867 review: true from a Retry press until the settings read answers again. */
    val reloadingSettings: Boolean = false,
)

class SettingsViewModel(private val dataSource: AuntieDataSource) {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined + reportingExceptionHandler("vm:Settings"))

    private val _uiState = MutableStateFlow(SettingsUiState())
    val uiState: StateFlow<SettingsUiState> = _uiState.asStateFlow()

    private var settingsJob: kotlinx.coroutines.Job? = null

    init {
        collectSettings()
    }

    private fun collectSettings() {
        // #867 review: one collection at a time. The scope never cancels, so a retry
        // that relaunched without cancelling would leave the old polling loop running.
        settingsJob?.cancel()
        settingsJob = scope.launch {
            activePolls.update { it + 1 }
            try {
                dataSource.businessSettingsStream().collect { result ->
                    _uiState.update { it.copy(settingsResult = result, reloadingSettings = false) }
                }
            } finally {
                activePolls.update { it - 1 }
            }
        }
    }

    /**
     * #867 re-review: stops the settings read. `SettingsScreen` calls it when it
     * leaves composition. On desktop the read is a polling loop that never ends by
     * itself, so without this every visit to Settings left one more loop running.
     * The scope itself stays alive, so a vet clinic save already under way finishes.
     */
    fun dispose() {
        settingsJob?.cancel()
        settingsJob = null
    }

    companion object {
        private val activePolls = MutableStateFlow(0)

        /** How many settings reads are running in this process, for the leak test. */
        internal val activeSettingsPolls: StateFlow<Int> = activePolls.asStateFlow()

        /** #998: the busy-id [addVetClinic] uses, since a new clinic has no id yet. */
        const val ADD_VET_CLINIC_BUSY_ID: String = "__add_vet_clinic__"
    }

    /** #867 review: read business settings again now, for the load error banner's Retry. */
    fun retrySettings() {
        _uiState.update { it.copy(reloadingSettings = true) }
        collectSettings()
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
    suspend fun updateVetClinic(loaded: VetClinic, edited: VetClinic): WriteResult<Unit> = dataSource.updateVetClinic(loaded, edited)
    /** #998: `archived = true` retires (or rejects a pending submission); `false` restores. */
    suspend fun archiveVetClinic(id: String, archived: Boolean): WriteResult<Unit> = dataSource.archiveVetClinic(id, archived)

    // Fail-loud write actions for the UI: each launches on the VM scope and pushes
    // a human message to [vetClinicError] on failure (never silently swallowed).
    private val _vetClinicError = MutableStateFlow<String?>(null)
    val vetClinicError: StateFlow<String?> = _vetClinicError.asStateFlow()
    fun clearVetClinicError() { _vetClinicError.update { null } }

    /**
     * #998: ids of a write in flight, so a card's button can show a busy label
     * and disable itself for the wait, rather than looking clickable while an
     * archive/restore/create round-trips. [ADD_VET_CLINIC_BUSY_ID] stands in
     * for the add-clinic form, which has no clinic id yet.
     */
    private val _vetClinicBusyIds = MutableStateFlow<Set<String>>(emptySet())
    val vetClinicBusyIds: StateFlow<Set<String>> = _vetClinicBusyIds.asStateFlow()

    private fun report(label: String, result: WriteResult<*>) {
        _vetClinicError.value = if (result is WriteResult.Err) "$label: ${result.message}" else null
    }

    /**
     * Runs [write], tracking [busyId] busy for its duration and reporting a
     * failure to [vetClinicError]. A plain `suspend fun`, not `scope.async`:
     * `async` stores a thrown exception in its `Deferred` instead of routing it
     * to [scope]'s `reportingExceptionHandler`, which would silently drop a
     * `NetworkBlockedError` or a revoked-session rethrow that Sentry needs to
     * see. Every caller below wraps this in `scope.launch` so the handler stays
     * wired; [addVetClinicAwait] is the one caller that also wants the result.
     */
    private suspend fun <T> trackedVetClinicWrite(busyId: String, label: String, write: suspend () -> WriteResult<T>): WriteResult<T> {
        _vetClinicBusyIds.update { it + busyId }
        return try {
            val result = write()
            report(label, result)
            result
        } finally {
            _vetClinicBusyIds.update { it - busyId }
        }
    }

    fun addVetClinic(clinic: VetClinic) =
        scope.launch { trackedVetClinicWrite(ADD_VET_CLINIC_BUSY_ID, "Couldn't add ${clinic.name}") { dataSource.createVetClinic(clinic) } }
    /** [addVetClinic], but awaits the result so the add form can clear itself only on success. */
    suspend fun addVetClinicAwait(clinic: VetClinic): WriteResult<String> =
        trackedVetClinicWrite(ADD_VET_CLINIC_BUSY_ID, "Couldn't add ${clinic.name}") { dataSource.createVetClinic(clinic) }
    /** #994: [loaded] is the clinic the edit form was seeded from; only what changed is written. */
    fun saveVetClinic(loaded: VetClinic, edited: VetClinic) =
        scope.launch { trackedVetClinicWrite(loaded._id, "Couldn't save ${edited.name}") { dataSource.updateVetClinic(loaded, edited) } }
    /** #998: retires an active clinic through `archiveVetClinic`. There is no delete. */
    fun retireVetClinic(id: String, name: String) =
        scope.launch { trackedVetClinicWrite(id, "Couldn't retire ${name.ifBlank { "clinic" }}") { dataSource.archiveVetClinic(id, true) } }
    /** #998: brings a retired clinic back into the bank. */
    fun restoreVetClinic(id: String, name: String) =
        scope.launch { trackedVetClinicWrite(id, "Couldn't restore ${name.ifBlank { "clinic" }}") { dataSource.archiveVetClinic(id, false) } }

    /** Approve a kinfolk-submitted pending clinic: flip verified=true (and clear the
     *  submittedBy tag) so it joins the shared bank visible to every household. */
    fun approveVetClinic(clinic: VetClinic) =
        scope.launch { trackedVetClinicWrite(clinic._id, "Couldn't approve ${clinic.name}") { dataSource.updateVetClinic(clinic, clinic.copy(verified = true, submittedBy = "")) } }

    /** #998: reject a pending submission by retiring it through `archiveVetClinic`.
     *  The row stays, still carrying `submittedBy`, rather than being hard-deleted. */
    fun rejectVetClinic(id: String, name: String) =
        scope.launch { trackedVetClinicWrite(id, "Couldn't reject ${name.ifBlank { "clinic" }}") { dataSource.archiveVetClinic(id, true) } }
}
