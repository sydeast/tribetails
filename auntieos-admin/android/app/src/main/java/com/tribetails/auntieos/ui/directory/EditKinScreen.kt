package com.tribetails.auntieos.ui.directory

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import com.tribetails.auntieos.ui.components.AuntieCheckbox
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme

@Composable
fun EditKinScreen(
    viewModel: DirectoryViewModel,
    kinId: String,
    onBack: () -> Unit
) {
    val state by viewModel.editKinState.collectAsState()
    val breedBank by viewModel.breedBank.collectAsState()
    val breedBankFailed by viewModel.breedBankFailed.collectAsState()
    val context = LocalContext.current

    // Phase 3: refresh-intelligence (synthesize) state + feedback. Synthesis is
    // per-household, so this passes the kin's parent kinfolkId (state.kinfolkId).
    val isSynthesizing by viewModel.isSynthesizing.collectAsState()
    val synthesizeMessage by viewModel.synthesizeMessage.collectAsState()
    LaunchedEffect(synthesizeMessage) {
        synthesizeMessage?.let {
            android.widget.Toast.makeText(context, it, android.widget.Toast.LENGTH_LONG).show()
            viewModel.clearSynthesizeMessage()
        }
    }

    val photoPicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia()
    ) { uri -> if (uri != null) viewModel.uploadKinPhoto(context, uri) }

    LaunchedEffect(kinId) {
        viewModel.loadKinForEdit(kinId)
        viewModel.loadBreeds()
    }

    LaunchedEffect(state.isSuccess) {
        if (state.isSuccess) {
            onBack()
        }
    }

    AuntieScreenScaffold(
        title = "Edit Kin Profile",
        onBack = onBack,
        imePaddingEnabled = true,
    ) {
        if (state.isLoading) {
            com.tribetails.auntieos.ui.components.LoadingScreen(
                message  = "Loading kin data...",
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
                // Profile photo
                item {
                    ProfilePhotoCard(
                        photoUrl = state.profilePictureUrl,
                        isUploading = state.isUploadingPhoto,
                        fallbackInitial = state.name,
                        onPick = {
                            photoPicker.launch(
                                PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                            )
                        },
                    )
                }

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
                                onValueChange = viewModel::updateEditKinName,
                                label = "Name *",
                                isError = state.name.isBlank(),
                                modifier = Modifier.fillMaxWidth(),
                            )

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                AuntieDropdownField(
                                    value = state.species.ifBlank { null },
                                    options = listOf("Dog", "Cat", "Bird", "Rabbit", "Other"),
                                    onSelect = viewModel::updateEditKinSpecies,
                                    displayText = { it },
                                    label = "Species *",
                                    modifier = Modifier.weight(1f),
                                    placeholder = "Species",
                                )

                                run {
                                    val breedCatalog = breedCatalogForSpecies(
                                        state.species, breedBank.dogBreeds, breedBank.catBreeds,
                                    )
                                    BreedDropdownField(
                                        value = state.breed,
                                        onValueChange = viewModel::updateEditKinBreed,
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
                                    onValueChange = viewModel::updateEditKinAge,
                                    label = "Age",
                                    modifier = Modifier.weight(1f),
                                )

                                AuntieDropdownField(
                                    value = state.sex.ifBlank { null },
                                    options = listOf("Male", "Female", "Unknown"),
                                    onSelect = viewModel::updateEditKinSex,
                                    displayText = { it },
                                    // item 3: relabel "Sex" -> "Gender" (model key `sex` kept).
                                    label = "Gender *",
                                    modifier = Modifier.weight(1f),
                                    placeholder = "Gender",
                                )
                            }

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                AuntieField(
                                    value = state.weight,
                                    onValueChange = viewModel::updateEditKinWeight,
                                    label = "Weight",
                                    modifier = Modifier.weight(1f),
                                )

                                AuntieField(
                                    value = state.colorMarkings,
                                    onValueChange = viewModel::updateEditKinColorMarkings,
                                    label = "Color/Markings",
                                    modifier = Modifier.weight(1f),
                                )
                            }

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                AuntieCheckbox(
                                    checked = state.spayedNeutered,
                                    onCheckedChange = viewModel::updateEditKinSpayedNeutered,
                                )
                                Spacer(Modifier.width(8.dp))
                                Text("Spayed/Neutered")

                                Spacer(Modifier.width(24.dp))

                                AuntieCheckbox(
                                    checked = state.reactive,
                                    onCheckedChange = viewModel::updateEditKinReactive,
                                )
                                Spacer(Modifier.width(8.dp))
                                Text("Reactive")
                            }
                        }
                    }
                }

                // Care Information
                item {
                    AuntieCard(modifier = Modifier.fillMaxWidth()) {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            Text(
                                "CARE INFORMATION",
                                style = AuntieTheme.typography.labelSmall,
                                color = AuntieTheme.colors.kinfolkOrange
                            )

                            AuntieField(
                                value = state.staysAs,
                                onValueChange = viewModel::updateEditKinStaysAs,
                                label = "Stays As (confinement)",
                                modifier = Modifier.fillMaxWidth(),
                            )

                            AuntieField(
                                value = state.routine,
                                onValueChange = viewModel::updateEditKinRoutine,
                                label = "Daily Routine",
                                modifier = Modifier.fillMaxWidth(),
                                singleLine = false,
                                minLines = 2,
                            )

                            AuntieField(
                                value = state.trainingCommands,
                                onValueChange = viewModel::updateEditKinTrainingCommands,
                                label = "Training Commands",
                                modifier = Modifier.fillMaxWidth(),
                                singleLine = false,
                                minLines = 2,
                            )
                        }
                    }
                }

                // Feeding & Health
                item {
                    AuntieCard(modifier = Modifier.fillMaxWidth()) {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            Text(
                                "FEEDING & HEALTH",
                                style = AuntieTheme.typography.labelSmall,
                                color = AuntieTheme.colors.kinfolkOrange
                            )

                            AuntieField(
                                value = state.feedingBrand,
                                onValueChange = viewModel::updateEditKinFeedingBrand,
                                label = "Food Brand & Instructions",
                                modifier = Modifier.fillMaxWidth(),
                            )

                            AuntieField(
                                value = state.vaccinations,
                                onValueChange = viewModel::updateEditKinVaccinations,
                                label = "Vaccinations",
                                modifier = Modifier.fillMaxWidth(),
                                singleLine = false,
                                minLines = 2,
                            )

                            AuntieField(
                                value = state.medicationHealthNotes,
                                onValueChange = viewModel::updateEditKinMedicationHealthNotes,
                                label = "Medication & Health Notes",
                                modifier = Modifier.fillMaxWidth(),
                                singleLine = false,
                                minLines = 2,
                            )

                            // Vet is read-only here: authored once on the owning Kinfolk
                            // (household) and inherited. Edit it on the Kinfolk, not per-kin.
                            val vetLine = listOf(
                                state.householdVetName,
                                state.householdVetPhone,
                                state.householdVetAddress,
                            ).filter { it.isNotBlank() }.joinToString(" · ")
                            AuntieFieldLabel(text = "Vet (from ${state.householdName.ifBlank { "household" }})")
                            Text(
                                text = vetLine.ifBlank { "No household vet on file yet" },
                                style = AuntieTheme.typography.bodyMedium,
                                color = if (vetLine.isBlank()) AuntieTheme.colors.textDim else AuntieTheme.colors.textPrimary,
                            )
                        }
                    }
                }

                // Care Checklist (structured KIN form_schemas, spec 06 item 5) & Notes
                item {
                    AuntieCard(modifier = Modifier.fillMaxWidth()) {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            Text(
                                "CARE CHECKLIST & NOTES",
                                style = AuntieTheme.typography.labelSmall,
                                color = AuntieTheme.colors.kinfolkOrange
                            )

                            when {
                                // Fail loud: a schema load failure is shown, never swallowed.
                                state.schemaError != null -> Text(
                                    "Couldn't load the care-checklist fields: ${state.schemaError}",
                                    style = AuntieTheme.typography.bodySmall,
                                    color = AuntieTheme.colors.error,
                                )
                                state.kinSchemas.isNotEmpty() -> DynamicFormFields(
                                    schemas = state.kinSchemas,
                                    values = state.formValues,
                                    onValueChange = viewModel::updateEditKinFormValue,
                                )
                                // No KIN schema authored yet: point the operator at where to add one.
                                else -> Text(
                                    "No KIN care-checklist fields are configured yet. Add them in Format Schemas (applies to = KIN).",
                                    style = AuntieTheme.typography.bodySmall,
                                    color = AuntieTheme.colors.textDim,
                                )
                            }

                            // Legacy free-text checklist preserved READ-ONLY (no data loss).
                            if (state.checklist.isNotBlank()) {
                                AuntieFieldLabel(text = "Legacy care checklist (read-only)")
                                Text(
                                    text = state.checklist,
                                    style = AuntieTheme.typography.bodySmall,
                                    color = AuntieTheme.colors.textDim,
                                )
                            }

                            AuntieField(
                                value = state.officeNotes,
                                onValueChange = viewModel::updateEditKinOfficeNotes,
                                label = "Office Notes",
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
                    com.tribetails.auntieos.ui.components.LoadingButton(
                        onClick   = viewModel::saveKinChanges,
                        text      = "Save Changes",
                        isLoading = state.isSaving,
                        modifier  = Modifier.fillMaxWidth(),
                        // item 3: Name + Species + Gender all required.
                        enabled   = state.name.isNotBlank() && state.species.isNotBlank() && state.sex.isNotBlank()
                    )
                }

                // Phase 3: refresh-intelligence. Synthesis is per-HOUSEHOLD, so this
                // refreshes the kin's parent household (state.kinfolkId), not just this
                // pet; the label and caption say so. In-flight guarded; result toasts.
                item {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        GhostButton(
                            label = if (isSynthesizing) "Refreshing…" else "Refresh household intelligence",
                            enabled = !isSynthesizing && state.kinfolkId.isNotBlank(),
                            onClick = { viewModel.synthesizeProfile(state.kinfolkId) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Text(
                            "Updates the whole household's dossier and every pet's 411 (not just this pet).",
                            style = AuntieTheme.typography.labelSmall,
                            color = AuntieTheme.colors.textDim,
                        )
                    }
                }
            }
        }
    }
}
