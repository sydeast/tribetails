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

data class HouseholdDataUiState(
    val householdData: HouseholdData = HouseholdData(),
    // Phase 2: read-only free-text dossier householdNotes, shown as a fill-in
    // reference at the top of the editor. Blank when there is nothing to migrate.
    val dossierNotes: String = "",
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

    fun loadHouseholdData(kinfolkId: String) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            repository.getHouseholdData(kinfolkId).onSuccess { data ->
                _uiState.value = _uiState.value.copy(
                    householdData = data ?: HouseholdData(kinfolkId = kinfolkId),
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
        }
    }

    // Veterinary Information
    fun updatePrimaryVetName(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(primaryVetName = value)
        )
    }

    fun updatePrimaryVetPhone(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(primaryVetPhone = value)
        )
    }

    fun updatePrimaryVetAddress(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(primaryVetAddress = value)
        )
    }

    fun updatePrimaryVetHours(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(primaryVetHours = value)
        )
    }

    fun updateEmergencyVetName(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(emergencyVetName = value)
        )
    }

    fun updateEmergencyVetPhone(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(emergencyVetPhone = value)
        )
    }

    fun updateEmergencyVetAddress(value: String) {
        val current = _uiState.value.householdData
        _uiState.value = _uiState.value.copy(
            householdData = current.copy(emergencyVetAddress = value)
        )
    }

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

    fun saveHouseholdData() {
        val householdData = _uiState.value.householdData
        if (householdData.kinfolkId.isBlank()) {
            _uiState.value = _uiState.value.copy(error = "Kinfolk ID is required")
            return
        }

        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isSaving = true, error = null)

            repository.saveHouseholdData(householdData).onSuccess {
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
