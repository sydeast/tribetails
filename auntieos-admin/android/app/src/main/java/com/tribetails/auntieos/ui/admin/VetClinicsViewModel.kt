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

    /** Confirmation of a landed write, including how far a correction reached. */
    private val _notice = MutableStateFlow<String?>(null)
    val notice: StateFlow<String?> = _notice.asStateFlow()

    /**
     * The households behind each clinic's badge.
     *
     * This used to be a list of `vetClinicName` strings matched by name. That
     * conflates two different things: a household LINKED by `vetClinicId`, which
     * a correction reaches, and a legacy household that merely has the same name
     * typed in with no id, which it cannot. The badge now reports them
     * separately (see [vetClinicUsage]), so the operator is never told five
     * households will be updated when only two of them will be.
     *
     * Null until the read lands. Null is rendered as "checking", never as zero:
     * the control next to the badge retires the clinic, and "nobody uses this"
     * must not look like "we have not been able to check".
     */
    private val _households = MutableStateFlow<List<VetClinicHouseholdRef>?>(null)
    val households: StateFlow<List<VetClinicHouseholdRef>?> = _households.asStateFlow()

    init {
        viewModelScope.launch {
            // household_data, NOT kinfolk. The household vet moved there, so
            // counting the kinfolk fields would count something nothing writes
            // and report "No households" on every card, on the screen whose
            // whole job is saying how far a correction travels.
            repository.getAllHouseholdData().onSuccess { list ->
                _households.value = list.map {
                    VetClinicHouseholdRef(
                        vetClinicId = it.primaryVetClinicId,
                        vetClinicName = it.primaryVetName,
                        emergencyVetClinicId = it.emergencyVetClinicId,
                        emergencyVetClinicName = it.emergencyVetName,
                    )
                }
            }
        }
    }

    fun clearError() { _error.value = null }

    fun clearNotice() { _notice.value = null }

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

    /**
     * Save a correction, through the `updateVetClinic` callable.
     *
     * [notice] carries how far it travelled. A clinic edit rewrites the
     * denormalized copy on every linked household, and on a screen whose whole
     * job is fixing a number people dial, "saved" is a weaker claim than
     * "saved, and 3 households now read the new number".
     */
    fun save(clinic: VetClinic) = viewModelScope.launch {
        val result = repository.updateVetClinic(clinic)
        report("Couldn't save ${clinic.name}", result)
        result.getOrNull()?.let { count ->
            _notice.value = if (count > 0) {
                "Saved ${clinic.name}. $count household${if (count == 1) "" else "s"} now read the corrected details."
            } else {
                "Saved ${clinic.name}."
            }
        }
    }

    /**
     * Retire a clinic from the bank. NOT a delete, see
     * `AuntieRepository.archiveVetClinic`: a household points at a clinic by id
     * with no referential integrity, so removing the row would strand it.
     * Households already on the clinic keep every detail they hold, which the
     * notice says out loud rather than leaving the operator to guess whether
     * tidying the catalog just blanked somebody's vet.
     */
    fun retire(id: String, name: String) = viewModelScope.launch {
        val result = repository.archiveVetClinic(id, archived = true)
        report("Couldn't retire ${name.ifBlank { "clinic" }}", result)
        result.getOrNull()?.let { count ->
            _notice.value = if (count > 0) {
                "${name.ifBlank { "Clinic" }} retired. $count household${if (count == 1) "" else "s"} keep the details already on file."
            } else {
                "${name.ifBlank { "Clinic" }} retired."
            }
        }
    }

    /** Put a retired clinic back in the bank. */
    fun restore(id: String, name: String) = viewModelScope.launch {
        val result = repository.archiveVetClinic(id, archived = false)
        report("Couldn't restore ${name.ifBlank { "clinic" }}", result)
        if (result.isSuccess) _notice.value = "${name.ifBlank { "Clinic" }} is back in the bank."
    }

    /** Approve a kinfolk-submitted pending clinic: flip verified=true + clear the
     *  submittedBy tag so it joins the shared bank visible to every household. */
    fun approve(clinic: VetClinic) =
        viewModelScope.launch { report("Couldn't approve ${clinic.name}", repository.updateVetClinic(clinic.copy(verified = true, submittedBy = ""))) }

    /**
     * Reject a pending submission: RETIRE it rather than hard-delete it. The row
     * stays, still carrying `submittedBy`, and is invisible everywhere a rejected
     * submission should be. Deleting it threw away the evidence of what was
     * submitted and by whom.
     */
    fun reject(id: String, name: String) = viewModelScope.launch {
        report("Couldn't reject ${name.ifBlank { "clinic" }}", repository.archiveVetClinic(id, archived = true))
    }
}
