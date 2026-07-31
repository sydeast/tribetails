package com.tribetails.auntieos.ui.directory

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme

@Composable
fun AddKinScreen(
    viewModel: DirectoryViewModel,
    kinfolkId: String,
    kinfolkName: String,
    onBack: () -> Unit,
    onSaved: () -> Unit
) {
    val state by viewModel.addKinState.collectAsState()
    val breedBank by viewModel.breedBank.collectAsState()
    val breedBankFailed by viewModel.breedBankFailed.collectAsState()

    LaunchedEffect(state.isSuccess) {
        if (state.isSuccess) {
            onSaved()
        }
    }

    LaunchedEffect(kinfolkId) {
        viewModel.setKinfolkForNewKin(kinfolkId)
        viewModel.loadBreeds()
    }

    AuntieScreenScaffold(
        title = "Add Kin for $kinfolkName",
        onBack = onBack,
        imePaddingEnabled = true,
    ) {
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            contentPadding = PaddingValues(vertical = 16.dp)
        ) {
            // Basic Information
            item {
                AuntieCard(modifier = Modifier.fillMaxWidth()) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Text(
                            "BASIC INFORMATION",
                            style = AuntieTheme.typography.labelSmall,
                            color = AuntieTheme.colors.kinfolkOrange
                        )

                        AuntieField(
                            value = state.name,
                            onValueChange = viewModel::updateKinName,
                            label = "Pet Name",
                            modifier = Modifier.fillMaxWidth(),
                        )

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            AuntieDropdownField(
                                value = state.species.ifBlank { null },
                                options = listOf("Dog", "Cat", "Bird", "Other"),
                                onSelect = viewModel::updateKinSpecies,
                                displayText = { it },
                                label = "Species",
                                modifier = Modifier.weight(1f),
                                placeholder = "Species",
                            )

                            run {
                                val breedCatalog = breedCatalogForSpecies(
                                    state.species, breedBank.dogBreeds, breedBank.catBreeds,
                                )
                                BreedDropdownField(
                                    value = state.breed,
                                    onValueChange = viewModel::updateKinBreed,
                                    catalog = breedCatalog,
                                    // breedBankNote covers BOTH silent-empty causes: a
                                    // rejected getBreeds call AND a call that resolved
                                    // but came back empty because dog_breeds / cat_breeds
                                    // are not seeded. The two get distinct wording.
                                    note = breedBankNote(state.species, breedCatalog, breedBankFailed),
                                    modifier = Modifier.weight(1f),
                                )
                            }
                        }

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            AuntieField(
                                value = state.age,
                                onValueChange = viewModel::updateKinAge,
                                label = "Age",
                                modifier = Modifier.weight(1f),
                            )

                            AuntieDropdownField(
                                value = state.sex.ifBlank { null },
                                options = listOf("Male", "Female", "Unknown"),
                                onSelect = viewModel::updateKinSex,
                                displayText = { it },
                                label = "Sex",
                                modifier = Modifier.weight(1f),
                                placeholder = "Sex",
                            )

                            AuntieField(
                                value = state.weight,
                                onValueChange = viewModel::updateKinWeight,
                                label = "Weight",
                                modifier = Modifier.weight(1f),
                            )
                        }
                    }
                }
            }

            // Medical Information
            item {
                AuntieCard(modifier = Modifier.fillMaxWidth()) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Text(
                            "MEDICAL INFORMATION",
                            style = AuntieTheme.typography.labelSmall,
                            color = AuntieTheme.colors.kinfolkOrange
                        )

                        AuntieField(
                            value = state.vetClinicName,
                            onValueChange = viewModel::updateKinVetClinicName,
                            label = "Vet Clinic Name",
                            modifier = Modifier.fillMaxWidth(),
                        )

                        AuntieField(
                            value = state.vetPhone,
                            onValueChange = viewModel::updateKinVetPhone,
                            label = "Vet Phone",
                            modifier = Modifier.fillMaxWidth(),
                        )

                        AuntieField(
                            value = state.allergies,
                            onValueChange = viewModel::updateKinAllergies,
                            label = "Allergies",
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = false,
                            minLines = 2,
                        )

                        AuntieField(
                            value = state.medicalConditions,
                            onValueChange = viewModel::updateKinMedicalConditions,
                            label = "Medical Conditions",
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = false,
                            minLines = 2,
                        )

                        AuntieField(
                            value = state.medications,
                            onValueChange = viewModel::updateKinMedications,
                            label = "Medications",
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = false,
                            minLines = 2,
                        )
                    }
                }
            }

            // Routine & Care
            item {
                AuntieCard(modifier = Modifier.fillMaxWidth()) {
                    Column(
                        modifier = Modifier.padding(16.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        Text(
                            "ROUTINE & CARE",
                            style = AuntieTheme.typography.labelSmall,
                            color = AuntieTheme.colors.kinfolkOrange
                        )

                        AuntieField(
                            value = state.feedingBrand,
                            onValueChange = viewModel::updateKinFeedingBrand,
                            label = "Feeding Brand",
                            modifier = Modifier.fillMaxWidth(),
                        )

                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)
                        ) {
                            AuntieField(
                                value = state.feedingAmount,
                                onValueChange = viewModel::updateKinFeedingAmount,
                                label = "Amount",
                                modifier = Modifier.weight(1f),
                            )
                            AuntieField(
                                value = state.feedingFrequency,
                                onValueChange = viewModel::updateKinFeedingFrequency,
                                label = "Frequency",
                                modifier = Modifier.weight(1f),
                            )
                        }

                        AuntieField(
                            value = state.pottyRoutine,
                            onValueChange = viewModel::updateKinPottyRoutine,
                            label = "Potty Routine",
                            modifier = Modifier.fillMaxWidth(),
                            singleLine = false,
                            minLines = 2,
                        )
                    }
                }
            }

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

            // Save Button
            item {
                PrimaryButton(
                    label = "Save Kin Profile",
                    onClick = viewModel::saveKin,
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !state.isSaving && state.name.isNotBlank(),
                    loading = state.isSaving,
                )
            }
        }
    }
}
