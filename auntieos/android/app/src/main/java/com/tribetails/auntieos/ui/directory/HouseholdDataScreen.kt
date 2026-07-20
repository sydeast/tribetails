package com.tribetails.auntieos.ui.directory

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.components.LoadingButton
import com.tribetails.auntieos.ui.components.LoadingScreen
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme

@Composable
fun HouseholdDataScreen(
    kinfolkId: String,
    kinfolkName: String,
    viewModel: HouseholdDataViewModel = viewModel(),
    onBack: () -> Unit
) {
    val state by viewModel.uiState.collectAsState()

    LaunchedEffect(kinfolkId) {
        viewModel.loadHouseholdData(kinfolkId)
    }

    LaunchedEffect(state.isSuccess) {
        if (state.isSuccess) {
            viewModel.clearSuccessState()
        }
    }

    AuntieScreenScaffold(title = "$kinfolkName Household", onBack = onBack) {
        if (state.isLoading) {
            LoadingScreen(
                message  = "Loading household data...",
                modifier = Modifier.fillMaxSize()
            )
        } else {
            LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                contentPadding = PaddingValues(vertical = 16.dp)
            ) {
                // Phase 2: read-only dossier notes shown as a fill-in reference when present.
                if (state.dossierNotes.isNotBlank()) {
                    item { DossierReferenceCard(state.dossierNotes) }
                }
                item { VeterinaryInfoCard(viewModel) }
                item { HouseholdItemsCard(viewModel) }
                item { RoutinesCard(viewModel) }
                item { EmergencySafetyCard(viewModel) }
                item { ServiceProvidersCard(viewModel) }

                // Error Message
                if (state.error != null) {
                    item {
                        AuntieCard(
                            modifier = Modifier.fillMaxWidth(),
                            containerColor = AuntieTheme.colors.errorContainer,
                            border = null,
                        ) {
                            Text(
                                text = state.error!!,
                                modifier = Modifier.padding(16.dp),
                                color = AuntieTheme.colors.error
                            )
                        }
                    }
                }

                item {
                    LoadingButton(
                        onClick   = viewModel::saveHouseholdData,
                        text      = "Save Household Data",
                        isLoading = state.isSaving,
                        modifier  = Modifier.fillMaxWidth()
                    )
                }
            }
        }
    }
}

/**
 * Phase 2: appends a quiet " · empty" tag to a field's label when its value is blank,
 * so the admin migrating dossier notes can see at a glance which structured fields
 * still need filling. Purely a label hint; no behavior change.
 */
private fun fieldLabel(base: String, value: String): String =
    if (value.isBlank()) "$base · empty" else base

/** Phase 2: read-only dossier notes shown as a fill-in reference above the editor fields. */
@Composable
private fun DossierReferenceCard(notes: String) {
    AuntieCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Text("FROM DOSSIER (REFERENCE)", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.kinfolkOrange)
            Text(
                "Admin only / internal. Copy details into the fields below, then clear it on the profile.",
                style = AuntieTheme.typography.labelSmall,
                color = AuntieTheme.colors.textDim
            )
            Text(notes, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary)
        }
    }
}

@Composable
private fun VeterinaryInfoCard(viewModel: HouseholdDataViewModel) {
    val state by viewModel.uiState.collectAsState()
    val data = state.householdData

    AuntieCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(
                "VETERINARY INFORMATION",
                style = AuntieTheme.typography.labelSmall,
                color = AuntieTheme.colors.kinfolkOrange
            )

            Text("Primary Veterinarian", style = AuntieTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)

            AuntieField(
                value = data.primaryVetName,
                onValueChange = viewModel::updatePrimaryVetName,
                label = fieldLabel("Vet Name", data.primaryVetName),
                modifier = Modifier.fillMaxWidth(),
            )

            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AuntieField(
                    value = data.primaryVetPhone,
                    onValueChange = viewModel::updatePrimaryVetPhone,
                    label = fieldLabel("Phone", data.primaryVetPhone),
                    modifier = Modifier.weight(1f),
                )
                AuntieField(
                    value = data.primaryVetHours,
                    onValueChange = viewModel::updatePrimaryVetHours,
                    label = fieldLabel("Hours", data.primaryVetHours),
                    modifier = Modifier.weight(1f),
                )
            }

            AuntieField(
                value = data.primaryVetAddress,
                onValueChange = viewModel::updatePrimaryVetAddress,
                label = fieldLabel("Address", data.primaryVetAddress),
                modifier = Modifier.fillMaxWidth(),
                singleLine = false,
                minLines = 2,
            )

            Spacer(Modifier.height(8.dp))

            Text("Emergency Veterinarian", style = AuntieTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)

            AuntieField(
                value = data.emergencyVetName,
                onValueChange = viewModel::updateEmergencyVetName,
                label = fieldLabel("Emergency Vet Name", data.emergencyVetName),
                modifier = Modifier.fillMaxWidth(),
            )

            AuntieField(
                value = data.emergencyVetPhone,
                onValueChange = viewModel::updateEmergencyVetPhone,
                label = fieldLabel("Emergency Phone", data.emergencyVetPhone),
                modifier = Modifier.fillMaxWidth(),
            )

            AuntieField(
                value = data.emergencyVetAddress,
                onValueChange = viewModel::updateEmergencyVetAddress,
                label = fieldLabel("Emergency Address", data.emergencyVetAddress),
                modifier = Modifier.fillMaxWidth(),
                singleLine = false,
                minLines = 2,
            )
        }
    }
}

@Composable
private fun HouseholdItemsCard(viewModel: HouseholdDataViewModel) {
    val state by viewModel.uiState.collectAsState()
    val data = state.householdData

    AuntieCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(
                "HOUSEHOLD ITEMS & LOCATIONS",
                style = AuntieTheme.typography.labelSmall,
                color = AuntieTheme.colors.kinfolkOrange
            )

            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AuntieField(
                    value = data.foodLocation,
                    onValueChange = viewModel::updateFoodLocation,
                    label = fieldLabel("Food Location", data.foodLocation),
                    modifier = Modifier.weight(1f),
                )
                AuntieField(
                    value = data.treatLocation,
                    onValueChange = viewModel::updateTreatLocation,
                    label = fieldLabel("Treats Location", data.treatLocation),
                    modifier = Modifier.weight(1f),
                )
            }

            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AuntieField(
                    value = data.medicationLocation,
                    onValueChange = viewModel::updateMedicationLocation,
                    label = fieldLabel("Medications", data.medicationLocation),
                    modifier = Modifier.weight(1f),
                )
                AuntieField(
                    value = data.toysLocation,
                    onValueChange = viewModel::updateToysLocation,
                    label = fieldLabel("Toys Location", data.toysLocation),
                    modifier = Modifier.weight(1f),
                )
            }

            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AuntieField(
                    value = data.beddingLocation,
                    onValueChange = viewModel::updateBeddingLocation,
                    label = fieldLabel("Bedding", data.beddingLocation),
                    modifier = Modifier.weight(1f),
                )
                AuntieField(
                    value = data.leashesPoopBagsLocation,
                    onValueChange = viewModel::updateLeashesPoopBagsLocation,
                    label = fieldLabel("Leashes & Bags", data.leashesPoopBagsLocation),
                    modifier = Modifier.weight(1f),
                )
            }

            AuntieField(
                value = data.cleaningSuppliesLocation,
                onValueChange = viewModel::updateCleaningSuppliesLocation,
                label = fieldLabel("Cleaning Supplies Location", data.cleaningSuppliesLocation),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun RoutinesCard(viewModel: HouseholdDataViewModel) {
    val state by viewModel.uiState.collectAsState()
    val data = state.householdData

    AuntieCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(
                "ROUTINES & PREFERENCES",
                style = AuntieTheme.typography.labelSmall,
                color = AuntieTheme.colors.kinfolkOrange
            )

            AuntieField(
                value = data.householdRules,
                onValueChange = viewModel::updateHouseholdRules,
                label = fieldLabel("Household Rules", data.householdRules),
                modifier = Modifier.fillMaxWidth(),
                singleLine = false,
                minLines = 2,
            )

            AuntieField(
                value = data.preferredWalkRoutes,
                onValueChange = viewModel::updatePreferredWalkRoutes,
                label = fieldLabel("Preferred Walk Routes", data.preferredWalkRoutes),
                modifier = Modifier.fillMaxWidth(),
                singleLine = false,
                minLines = 2,
            )

            AuntieField(
                value = data.neighborhoodHazards,
                onValueChange = viewModel::updateNeighborhoodHazards,
                label = fieldLabel("Neighborhood Hazards/Warnings", data.neighborhoodHazards),
                modifier = Modifier.fillMaxWidth(),
                singleLine = false,
                minLines = 2,
            )

            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AuntieField(
                    value = data.securitySystemInfo,
                    onValueChange = viewModel::updateSecuritySystemInfo,
                    label = fieldLabel("Security System", data.securitySystemInfo),
                    modifier = Modifier.weight(1f),
                )
                AuntieField(
                    value = data.thermostatInstructions,
                    onValueChange = viewModel::updateThermostatInstructions,
                    label = fieldLabel("Thermostat", data.thermostatInstructions),
                    modifier = Modifier.weight(1f),
                )
            }

            AuntieField(
                value = data.lightingPreferences,
                onValueChange = viewModel::updateLightingPreferences,
                label = fieldLabel("Lighting Preferences", data.lightingPreferences),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun EmergencySafetyCard(viewModel: HouseholdDataViewModel) {
    val state by viewModel.uiState.collectAsState()
    val data = state.householdData

    AuntieCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(
                "EMERGENCY & SAFETY",
                style = AuntieTheme.typography.labelSmall,
                color = AuntieTheme.colors.kinfolkOrange
            )

            AuntieField(
                value = data.poisonControlNumber,
                onValueChange = viewModel::updatePoisonControlNumber,
                label = fieldLabel("Poison Control Number", data.poisonControlNumber),
                modifier = Modifier.fillMaxWidth(),
            )

            AuntieField(
                value = data.emergencyContactsPriority,
                onValueChange = viewModel::updateEmergencyContactsPriority,
                label = fieldLabel("Emergency Contacts Priority", data.emergencyContactsPriority),
                modifier = Modifier.fillMaxWidth(),
                singleLine = false,
                minLines = 2,
            )

            AuntieField(
                value = data.evacuationPlan,
                onValueChange = viewModel::updateEvacuationPlan,
                label = fieldLabel("Evacuation Plan", data.evacuationPlan),
                modifier = Modifier.fillMaxWidth(),
                singleLine = false,
                minLines = 2,
            )

            AuntieField(
                value = data.importantDocumentsLocation,
                onValueChange = viewModel::updateImportantDocumentsLocation,
                label = fieldLabel("Important Documents Location", data.importantDocumentsLocation),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

@Composable
private fun ServiceProvidersCard(viewModel: HouseholdDataViewModel) {
    val state by viewModel.uiState.collectAsState()
    val data = state.householdData

    AuntieCard(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(
                "SERVICE PROVIDERS",
                style = AuntieTheme.typography.labelSmall,
                color = AuntieTheme.colors.kinfolkOrange
            )

            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AuntieField(
                    value = data.groomerName,
                    onValueChange = viewModel::updateGroomerName,
                    label = fieldLabel("Groomer Name", data.groomerName),
                    modifier = Modifier.weight(1f),
                )
                AuntieField(
                    value = data.groomerPhone,
                    onValueChange = viewModel::updateGroomerPhone,
                    label = fieldLabel("Groomer Phone", data.groomerPhone),
                    modifier = Modifier.weight(1f),
                )
            }

            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AuntieField(
                    value = data.trainerName,
                    onValueChange = viewModel::updateTrainerName,
                    label = fieldLabel("Trainer Name", data.trainerName),
                    modifier = Modifier.weight(1f),
                )
                AuntieField(
                    value = data.trainerPhone,
                    onValueChange = viewModel::updateTrainerPhone,
                    label = fieldLabel("Trainer Phone", data.trainerPhone),
                    modifier = Modifier.weight(1f),
                )
            }

            AuntieField(
                value = data.petSitterBackup,
                onValueChange = viewModel::updatePetSitterBackup,
                label = fieldLabel("Backup Pet Sitter", data.petSitterBackup),
                modifier = Modifier.fillMaxWidth(),
            )

            AuntieField(
                value = data.dogWalkerBackup,
                onValueChange = viewModel::updateDogWalkerBackup,
                label = fieldLabel("Backup Dog Walker", data.dogWalkerBackup),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
