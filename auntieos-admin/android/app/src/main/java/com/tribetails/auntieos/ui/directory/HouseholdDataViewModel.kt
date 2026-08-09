package com.tribetails.auntieos.ui.directory

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.HouseholdData
import com.tribetails.auntieos.data.repository.AuntieRepository
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * The household's canonical vet, READ THROUGH from the kinfolk record
 * (punchlist A2).
 *
 * This screen used to author its own `primaryVet*` / `emergencyVet*` free text,
 * so the vet lived in two stores with nothing tying them together, and the copy
 * shown HERE, on the screen a sitter reads the emergency number off, was the one
 * that could silently go stale.
 *
 * `kinfolk` owns it now: the regular and the emergency clinic are each picked
 * from the shared `vet_clinics` catalog and carry that clinic's id. That is the
 * copy `updateVetClinic` can correct and fan out, which is the only reason a
 * wrong number can be fixed at all. [primaryHours] / [emergencyHours] resolve
 * from the CLINIC, not the household: every household using a practice shares
 * its opening hours, so there is one copy of them rather than one per household.
 */
data class CanonicalVet(
    val primaryName: String = "",
    val primaryPhone: String = "",
    val primaryAddress: String = "",
    val primaryHours: String = "",
    /** False when the household holds a vet with no catalog id: unreachable by a correction. */
    val primaryLinked: Boolean = false,
    val emergencyName: String = "",
    val emergencyPhone: String = "",
    val emergencyAddress: String = "",
    val emergencyHours: String = "",
) {
    val hasPrimary: Boolean get() = primaryName.isNotBlank() || primaryPhone.isNotBlank() || primaryAddress.isNotBlank()
    val hasEmergency: Boolean get() = emergencyName.isNotBlank() || emergencyPhone.isNotBlank() || emergencyAddress.isNotBlank()
    val hasAny: Boolean get() = hasPrimary || hasEmergency
}

data class HouseholdDataUiState(
    val householdData: HouseholdData = HouseholdData(),
    // Phase 2: read-only free-text dossier householdNotes, shown as a fill-in
    // reference at the top of the editor. Blank when there is nothing to migrate.
    val dossierNotes: String = "",
    /** Null until the catalog read lands. Never rendered as "no vet". */
    val vet: HouseholdVet? = null,
    /** Set when the vet read failed, so the card fails loud rather than blank. */
    val vetError: String? = null,
    val isLoading: Boolean = true,
    val isSaving: Boolean = false,
    val isSuccess: Boolean = false,
    val error: String? = null
)

class HouseholdDataViewModel(
    private val repository: AuntieRepository = AuntieOSApp.instance.repository
) : ViewModel() {

    private val _uiState = MutableStateFlow(HouseholdDataUiState())
    val uiState: StateFlow<HouseholdDataUiState> = _uiState.asStateFlow()

    /**
     * The record AS THE SERVER LAST GAVE IT TO US, and the baseline every save
     * diffs against. Never re-read to compute a diff: a fresh read would hand
     * back the very concurrent edit the diff exists to leave alone.
     *
     * Advanced only after a save the server accepted, so a failed save keeps the
     * operator's edit pending instead of swallowing it.
     */
    private var loadedHouseholdData = HouseholdData()

    fun loadHouseholdData(kinfolkId: String) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            repository.getHouseholdData(kinfolkId).onSuccess { data ->
                val record = data ?: HouseholdData(kinfolkId = kinfolkId)
                loadedHouseholdData = record
                _uiState.value = _uiState.value.copy(
                    householdData = record,
                    isLoading = false
                )
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    error = "Failed to load household data: ${error.message}"
                )
            }
            // Phase 2: load the free-text dossier notes as a fill-in reference. A read
            // failure leaves the reference card hidden (the editor still works); it does
            // not blank or fail the household load.
            repository.getDossier(kinfolkId).onSuccess { dossier ->
                _uiState.value = _uiState.value.copy(dossierNotes = dossier?.householdNotes.orEmpty())
            }
            loadCanonicalVet(_uiState.value.householdData)
        }
    }
    /**
     * Resolves the household's OWN vet: `household_data` holds the clinic id
     * (operator ruling 2026-08-01) and the catalog supplies the name, phone,
     * address and hours. This used to read the kinfolk doc, which is the copy
     * that made the vet authored in two places at once.
     *
     * A catalog failure sets [vetError] rather than leaving the card blank: a
     * blank vet card and an unreadable one must not look alike on the screen
     * someone reads an emergency number off.
     */
    private suspend fun loadCanonicalVet(household: HouseholdData?) {
        repository.getVetClinicsOnce()
            .onSuccess { clinics ->
                _uiState.value = _uiState.value.copy(
                    vetError = null,
                    vet = resolveHouseholdVet(household, clinics),
                )
            }
            .onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    vet = null,
                    vetError = "Couldn't load the shared clinic catalog: ${error.message}",
                )
            }
    }

    // The seven `primaryVet*` / `emergencyVet*` setters are GONE (punchlist A2).
    // The vet is authored on the household profile, against the shared clinic
    // catalog, and read through here. The stored fields remain on the model so
    // a household that still carries the old free text can be shown it (and so
    // the migration can find it), but nothing writes them any more.

    // Household Items & Locations
    fun updateFoodLocation(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(foodLocation = value)
        )
    }

    fun updateTreatLocation(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(treatLocation = value)
        )
    }

    fun updateMedicationLocation(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(medicationLocation = value)
        )
    }

    fun updateToysLocation(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(toysLocation = value)
        )
    }

    fun updateBeddingLocation(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(beddingLocation = value)
        )
    }

    fun updateLeashesPoopBagsLocation(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(leashesPoopBagsLocation = value)
        )
    }

    fun updateCleaningSuppliesLocation(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(cleaningSuppliesLocation = value)
        )
    }

    // Household Routines & Preferences
    fun updateHouseholdRules(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(householdRules = value)
        )
    }

    fun updatePreferredWalkRoutes(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(preferredWalkRoutes = value)
        )
    }

    fun updateNeighborhoodHazards(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(neighborhoodHazards = value)
        )
    }

    fun updateSecuritySystemInfo(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(securitySystemInfo = value)
        )
    }

    fun updateThermostatInstructions(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(thermostatInstructions = value)
        )
    }

    fun updateLightingPreferences(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(lightingPreferences = value)
        )
    }

    // Emergency & Safety
    fun updatePoisonControlNumber(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(poisonControlNumber = value)
        )
    }

    fun updateEmergencyContactsPriority(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(emergencyContactsPriority = value)
        )
    }

    fun updateEvacuationPlan(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(evacuationPlan = value)
        )
    }

    fun updateImportantDocumentsLocation(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(importantDocumentsLocation = value)
        )
    }

    // Service Providers
    fun updateGroomerName(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(groomerName = value)
        )
    }

    fun updateGroomerPhone(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(groomerPhone = value)
        )
    }

    fun updateTrainerName(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(trainerName = value)
        )
    }

    fun updateTrainerPhone(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(trainerPhone = value)
        )
    }

    fun updatePetSitterBackup(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(petSitterBackup = value)
        )
    }

    fun updateDogWalkerBackup(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(dogWalkerBackup = value)
        )
    }

    /**
     * Saves ONLY what the operator actually changed.
     *
     * This used to hand the repository the whole in-memory model, which then
     * went to Firestore as `.set(model, merge())`. `merge()` guards fields
     * OUTSIDE the written map and does nothing about stale ones inside it, so
     * every field this screen loaded went back at its old value and reverted
     * whatever the React admin had changed in the meantime - the household's
     * vet among them ([HouseholdData.primaryVetClinicId]). React fixed the same
     * bug from its side first and says why: `src/api/householdData.ts:110-127`,
     * citing the 2026-07-20 `familyKinPath` loss.
     *
     * NOTHING CHANGED MEANS NOTHING IS WRITTEN, not even the stamp. `updatedAt`
     * says when the record last changed; moving it for a save that changed
     * nothing makes it lie, and the repository already refuses to round-trip it
     * for the same reason. The screen still reports success, because "saved" and
     * "nothing to save" are the same outcome to the operator.
     */
    fun saveHouseholdData() {
        val householdData = _uiState.value.householdData
        if (householdData.kinfolkId.isBlank()) {
            _uiState.value = _uiState.value.copy(error = "Kinfolk ID is required")
            return
        }

        // No document yet: the create path writes the whole record, because there
        // is nothing on the server to clobber.
        //
        // THE NEW ID GOES STRAIGHT BACK INTO STATE. It used to be discarded, so
        // the record kept a blank id and a second press of Save took this branch
        // AGAIN, creating a SECOND `household_data` document for the same
        // household; `getHouseholdData` then picked between the twins with
        // `limit(1)`. Adopting the id is what routes the second save through the
        // edit path, and moves the baseline with it so that save diffs against
        // what was actually written.
        if (householdData.id.isBlank()) {
            viewModelScope.launch {
                _uiState.value = _uiState.value.copy(isSaving = true, error = null)
                repository.saveHouseholdData(householdData).onSuccess { createdId ->
                    val created = householdData.copy(id = createdId)
                    loadedHouseholdData = created
                    _uiState.value = _uiState.value.copy(
                        householdData = created,
                        isSaving = false,
                        isSuccess = true,
                    )
                }.onFailure { error ->
                    _uiState.value = _uiState.value.copy(
                        isSaving = false,
                        error = "Failed to save household data: ${error.message}"
                    )
                }
            }
            return
        }

        val changes = householdFieldChanges(loadedHouseholdData, householdData)
        if (changes.isEmpty()) {
            _uiState.value = _uiState.value.copy(isSaving = false, isSuccess = true, error = null)
            return
        }

        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isSaving = true, error = null)

            repository.updateHouseholdFields(householdData.id, changes).onSuccess {
                // The baseline moves to what the server now holds. Without this a
                // second save re-sends the first save's fields, which is the same
                // clobber one step later.
                loadedHouseholdData = householdData
                _uiState.value = _uiState.value.copy(
                    isSaving = false,
                    isSuccess = true
                )
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    isSaving = false,
                    error = "Failed to save household data: ${error.message}"
                )
            }
        }
    }

    fun clearSuccessState() {
        _uiState.value = _uiState.value.copy(isSuccess = false)
    }
}
