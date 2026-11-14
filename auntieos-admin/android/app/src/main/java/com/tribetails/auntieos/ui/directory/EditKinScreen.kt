package com.tribetails.auntieos.ui.directory

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
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
    val measureErrors = viewModel.editKinMeasureErrors(state)
    val breedBank by viewModel.breedBank.collectAsState()
    val breedBankFailed by viewModel.breedBankFailed.collectAsState()
    val context = LocalContext.current
    // #1009: read once here, at the top of the composable - see
    // AddKinfolkScreen's identical comment for why.
    val confirmation = LocalSaveConfirmation.current

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

    // #1009: covers both ways this screen sets a message - a save
    // (saveKinChanges) and an archive/restore (setKinArchived) - both flip the
    // same isSuccess flag below, so one effect handles both.
    LaunchedEffect(state.successMessage) {
        state.successMessage?.let {
            confirmation.show(it)
            viewModel.clearEditKinSuccessMessage()
        }
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
                                    isError = measureErrors.age != null,
                                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
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
                                    isError = measureErrors.weight != null,
                                )

                                AuntieField(
                                    value = state.colorMarkings,
                                    onValueChange = viewModel::updateEditKinColorMarkings,
                                    label = "Color/Markings",
                                    modifier = Modifier.weight(1f),
                                )
                            }
                            // #1583: the reason, under the row, as soon as a value is refused.
                            measureErrors.first?.let {
                                Text(text = it, style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.error)
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
                                label = "Stays as",
                                modifier = Modifier.fillMaxWidth(),
                            )

                            AuntieField(
                                value = state.routine,
                                onValueChange = viewModel::updateEditKinRoutine,
                                label = "Routine",
                                modifier = Modifier.fillMaxWidth(),
                                singleLine = false,
                                minLines = 2,
                            )

                            AuntieField(
                                value = state.trainingCommands,
                                onValueChange = viewModel::updateEditKinTrainingCommands,
                                label = "Training / commands",
                                modifier = Modifier.fillMaxWidth(),
                                singleLine = false,
                                minLines = 2,
                            )
                            // #1908: the household's care block, the admin's to edit too.
                            AuntieField(
                                value = state.feedingInstructions,
                                onValueChange = viewModel::updateEditKinFeedingInstructions,
                                label = "Feeding instructions",
                                modifier = Modifier.fillMaxWidth(),
                                singleLine = false,
                                minLines = 2,
                            )
                            AuntieField(
                                value = state.walkingInstructions,
                                onValueChange = viewModel::updateEditKinWalkingInstructions,
                                label = "Walking instructions",
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
                                label = "Food / brand",
                                modifier = Modifier.fillMaxWidth(),
                            )

                            AuntieField(
                                value = state.allergies,
                                onValueChange = viewModel::updateEditKinAllergies,
                                label = "Allergies",
                                modifier = Modifier.fillMaxWidth(),
                                singleLine = false,
                                minLines = 2,
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
                                label = "Medications / health notes",
                                modifier = Modifier.fillMaxWidth(),
                                singleLine = false,
                                minLines = 2,
                            )

                            // #1908 kin-vet: the household's vet, read-only, unless
                            // "Different vet for this Kin" is ticked (unticked by default).
                            KinVetEditor(
                                householdName = state.householdName,
                                householdVetLine = listOf(
                                    state.householdVetName,
                                    state.householdVetPhone,
                                    state.householdVetAddress,
                                ).filter { it.isNotBlank() }.joinToString(" · "),
                                differentVet = state.differentVet,
                                ownVetClinicId = state.ownVetClinicId,
                                clinics = state.vetClinicOptions,
                                onDifferentVetChange = viewModel::updateEditKinDifferentVet,
                                onPick = viewModel::updateEditKinOwnVetClinic,
                                enabled = !state.isSaving,
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
                                value = state.emergencyNotes,
                                onValueChange = viewModel::updateEditKinEmergencyNotes,
                                label = "Emergency notes",
                                modifier = Modifier.fillMaxWidth(),
                                singleLine = false,
                                minLines = 2,
                            )
                            // The household's notes. NOT the office's own below.
                            AuntieField(
                                value = state.sitterNotes,
                                onValueChange = viewModel::updateEditKinSitterNotes,
                                label = "Notes for the Auntie",
                                modifier = Modifier.fillMaxWidth(),
                                singleLine = false,
                                minLines = 2,
                            )
                            AuntieField(
                                value = state.officeNotes,
                                onValueChange = viewModel::updateEditKinOfficeNotes,
                                label = "Auntie's notes",
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

                // Archive / Restore, where the React editor puts it, and the only
                // control that writes `kin.status`. Android could not reach the
                // field at all before this: a pet archived from the web could not
                // be brought back from the phone.
                item {
                    val archived = state.status.equals("archived", ignoreCase = true)
                    // #2017: Archive asks first, naming the Kin. Restore acts at
                    // once: it puts the Kin back, and Archive is there to undo it.
                    var askArchive by remember { mutableStateOf(false) }
                    GhostButton(
                        label = if (archived) "Restore" else "Archive",
                        onClick = { if (archived) viewModel.setKinArchived(false) else askArchive = true },
                        enabled = !state.isSaving && state.kinId.isNotBlank(),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    if (askArchive && !archived) {
                        AuntieModal(
                            onDismissRequest = { askArchive = false },
                            title = KIN_ARCHIVE_CONFIRM_TITLE,
                            confirmButton = {
                                PrimaryButton(
                                    label = "Archive",
                                    onClick = {
                                        askArchive = false
                                        viewModel.setKinArchived(true)
                                    },
                                )
                            },
                            dismissButton = {
                                AuntieTextBtn(onClick = { askArchive = false }) { Text("Cancel") }
                            },
                        ) {
                            Text(kinArchiveConfirmText(state.name))
                        }
                    }
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
/**
 * #1908 kin-vet (owner ruling 2026-11-12). The Kin's vet is the household's,
 * shown read-only, unless "Different vet for this Kin" is ticked; then it is a
 * dropdown of the area vet list, every clinic listed as soon as it opens.
 * Unticking goes back to the household's vet when the Kin is saved.
 */
@Composable
internal fun KinVetEditor(
    householdName: String,
    householdVetLine: String,
    differentVet: Boolean,
    ownVetClinicId: String,
    clinics: List<com.tribetails.auntieos.data.model.VetClinic>,
    onDifferentVetChange: (Boolean) -> Unit,
    onPick: (String) -> Unit,
    enabled: Boolean = true,
) {
    AuntieFieldLabel(text = "Vet (from ${householdName.ifBlank { "household" }})")
    Text(
        text = householdVetLine.ifBlank { "No household vet on file yet" },
        style = AuntieTheme.typography.bodyMedium,
        color = if (householdVetLine.isBlank()) AuntieTheme.colors.textDim else AuntieTheme.colors.textPrimary,
    )
    Row(verticalAlignment = Alignment.CenterVertically) {
        AuntieCheckbox(checked = differentVet, onCheckedChange = onDifferentVetChange, enabled = enabled)
        Spacer(Modifier.width(8.dp))
        Text("Different vet for this Kin")
    }
    if (differentVet) {
        // "" is the no-pick row; a picked id that left the list still shows as itself.
        val options = listOf("") + clinics.map { it.id } +
            listOfNotNull(ownVetClinicId.takeIf { it.isNotBlank() && clinics.none { c -> c.id == it } })
        AuntieSelectField(
            label = "Vet for this Kin",
            options = options,
            selected = ownVetClinicId,
            onSelect = onPick,
            optionLabel = { id -> kinVetOptionLabel(id, clinics) },
            enabled = enabled,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}
/** A dropdown row: the clinic's name, "Choose a vet" for none, and a plain note for a clinic no longer listed. */
internal fun kinVetOptionLabel(id: String, clinics: List<com.tribetails.auntieos.data.model.VetClinic>): String = when {
    id.isBlank() -> "Choose a vet"
    else -> clinics.firstOrNull { it.id == id }?.name?.trim()?.ifBlank { null } ?: "A vet no longer on the list"
}
