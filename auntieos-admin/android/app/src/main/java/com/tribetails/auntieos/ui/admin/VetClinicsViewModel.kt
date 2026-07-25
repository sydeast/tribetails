package com.tribetails.auntieos.ui.admin

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.data.model.VetClinic
import com.tribetails.auntieos.data.repository.AuntieRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * Owns the Settings "Vet clinics" CRUD for Android, mirroring the web
 * SettingsViewModel vet-clinic actions. Writes go through the repository and any
 * failure is pushed to [error] (fail loud, never silently swallowed), so the
 * panel can be tested with a mocked repository instead of a live Firestore.
 */
class VetClinicsViewModel(
    private val repository: AuntieRepository,
) : ViewModel() {

    val clinics: StateFlow<List<VetClinic>> =
        repository.observeVetClinics().stateIn(viewModelScope, SharingStarted.Eagerly, emptyList())

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    // #6: each household's chosen vet-clinic name, for the household-count badge.
    private val _kinfolkVetNames = MutableStateFlow<List<String>>(emptyList())
    val kinfolkVetNames: StateFlow<List<String>> = _kinfolkVetNames.asStateFlow()

    init {
        viewModelScope.launch {
            repository.getKinfolk().onSuccess { list ->
                _kinfolkVetNames.value = list.map { it.vetClinicName }
            }
        }
    }

    fun clearError() { _error.value = null }

    /** Sets a human message on failure; clears the error on success. */
    private fun report(label: String, result: Result<*>) {
        _error.value = result.exceptionOrNull()?.let { "$label: ${it.message}" }
    }

    /**
     * Adds through `submitVetClinic` rather than the direct `vet_clinics` write
     * this used to do. That callable dedupes on a NORMALIZED name and returns
     * the existing id on a match, so adding a clinic the bank already holds
     * under a different capitalisation no longer creates a second copy of it in
     * a catalog shared with the kinfolk portal. Staff callers land verified, so
     * an operator-added clinic is live immediately and does not queue itself for
     * the operator's own approval below.
     */
    fun add(clinic: VetClinic) =
        viewModelScope.launch { report("Couldn't add ${clinic.name}", repository.submitVetClinic(clinic)) }

    fun save(clinic: VetClinic) =
        viewModelScope.launch { report("Couldn't save ${clinic.name}", repository.updateVetClinic(clinic)) }

    fun remove(id: String, name: String) =
        viewModelScope.launch { report("Couldn't delete ${name.ifBlank { "clinic" }}", repository.deleteVetClinic(id)) }

    /** Approve a kinfolk-submitted pending clinic: flip verified=true + clear the
     *  submittedBy tag so it joins the shared bank visible to every household. */
    fun approve(clinic: VetClinic) =
        viewModelScope.launch { report("Couldn't approve ${clinic.name}", repository.updateVetClinic(clinic.copy(verified = true, submittedBy = ""))) }

    /** Reject a pending submission: hard-delete the unapproved doc. */
    fun reject(id: String, name: String) =
        viewModelScope.launch { report("Couldn't reject ${name.ifBlank { "clinic" }}", repository.deleteVetClinic(id)) }
}
