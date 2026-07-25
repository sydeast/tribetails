package com.tribetails.auntieos.ui.directory

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.AuntieOSApp
import com.tribetails.auntieos.data.model.TagDef
import com.tribetails.auntieos.data.model.TagScope
import com.tribetails.auntieos.data.model.addAssigned
import com.tribetails.auntieos.data.model.normalizeTagName
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme
import com.tribetails.auntieos.util.emailOkOrBlank
import com.tribetails.auntieos.util.formatJoinDate
import com.tribetails.auntieos.util.isValidPhone
import com.tribetails.auntieos.util.phoneOkOrBlank
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlin.coroutines.cancellation.CancellationException

@Composable
fun EditKinfolkScreen(
    viewModel: DirectoryViewModel,
    kinfolkId: String,
    onBack: () -> Unit,
    onDeleted: () -> Unit
) {
    val state by viewModel.editKinfolkState.collectAsState()
    // K3 (A8): the dossier (with householdNotes) lives in profileState, loaded when the
    // operator opened this kinfolk's profile — which is the only way into this editor.
    // We guard on the id match so a stale profile never bleeds into the wrong editor.
    val profile by viewModel.profileState.collectAsState()
    var showArchiveDialog by remember { mutableStateOf(false) }
    var showJoinDatePicker by remember { mutableStateOf(false) }
    var archiveReason     by remember { mutableStateOf("") }
    val isArchived = state.status.equals("archived", ignoreCase = true)
    val context = LocalContext.current

    val photoPicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia()
    ) { uri -> if (uri != null) viewModel.uploadKinfolkPhoto(context, uri) }

    // Tags (2026-07-19): the household vocabulary that backs the assign field
    // below. Loaded here rather than in the ViewModel so the field can ship
    // without widening the DirectoryViewModel contract; a load failure leaves the
    // field usable (free-form names still assign) but SAYS the suggestions are
    // missing, because an empty list and "no tags defined yet" look identical.
    val tagRepository = remember { AuntieOSApp.instance.repository }
    val tagScope = rememberCoroutineScope()
    var householdVocab by remember { mutableStateOf(emptyList<TagDef>()) }
    var vocabError by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(Unit) {
        try {
            householdVocab = loadTagVocab(tagRepository, TagScope.HOUSEHOLD)
            vocabError = null
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Throwable) {
            vocabError = tagVocabLoadErrorMessage(failure)
        }
    }

    // Promote a typed name into the managed vocabulary so it becomes a reusable
    // suggestion. A name already in the list is the one intentional no-op (the
    // assignment itself is handled by the field's own onChange); a failed WRITE
    // reverts the list and surfaces the reason.
    fun promoteHouseholdTag(name: String) {
        val next = promoteTagToVocab(householdVocab, name) ?: return
        val previous = householdVocab
        householdVocab = next
        tagScope.launch {
            val failure = try {
                saveTagVocab(tagRepository, TagScope.HOUSEHOLD, next)
                null
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failed: Throwable) {
                failed
            }
            val outcome = tagVocabOutcome(previous = previous, attempted = next, error = failure)
            householdVocab = outcome.vocab
            vocabError = outcome.error ?: vocabError
        }
    }

    LaunchedEffect(kinfolkId) {
        viewModel.loadKinfolkForEdit(kinfolkId)
    }

    LaunchedEffect(state.isSuccess) {
        if (state.isSuccess) {
            onBack()
        }
    }

    LaunchedEffect(state.isDeleted) {
        if (state.isDeleted) {
            onDeleted()
        }
    }

    AuntieScreenScaffold(
        title = "Edit Kinfolk",
        onBack = onBack,
        actions = {
            if (isArchived) {
                AuntieIconBtn(onClick = { viewModel.unarchiveKinfolk() }) {
                    Icon(Lucide.ArchiveRestore, contentDescription = "Unarchive", tint = AuntieTheme.colors.kinfolkOrange)
                }
            } else {
                AuntieIconBtn(onClick = { showArchiveDialog = true }) {
                    Icon(Lucide.Archive, contentDescription = "Archive", tint = AuntieTheme.colors.warning)
                }
            }
        },
        imePaddingEnabled = true,
    ) {
        if (state.isLoading) {
            com.tribetails.auntieos.ui.components.LoadingScreen(
                message  = "Loading kinfolk data...",
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
                // K3 (A8): household-notes migration box, re-homed here from the
                // read-only profile. Only when the loaded profile matches this kinfolk
                // and the dossier still carries un-migrated notes.
                val householdNotes = profile.dossier?.householdNotes.orEmpty()
                if (profile.kinfolk?.id == kinfolkId && householdNotes.isNotBlank()) {
                    item {
                        HouseholdNotesMigrationCard(
                            notes = householdNotes,
                            household = profile.householdData,
                            onOpenHouseholdData = null,
                            onClearFromDossier = { viewModel.clearDossierHouseholdNotes(kinfolkId) },
                        )
                    }
                }

                // Profile photo
                item {
                    ProfilePhotoCard(
                        photoUrl = state.profilePictureUrl,
                        isUploading = state.isUploadingPhoto,
                        fallbackInitial = state.firstName,
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

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                AuntieField(
                                    value = state.firstName,
                                    onValueChange = viewModel::updateEditFirstName,
                                    label = "First Name",
                                    modifier = Modifier.weight(1f),
                                )
                                AuntieField(
                                    value = state.lastName,
                                    onValueChange = viewModel::updateEditLastName,
                                    label = "Last Name",
                                    modifier = Modifier.weight(1f),
                                )
                            }

                            AuntieField(
                                value = state.phoneNumber,
                                onValueChange = viewModel::updateEditPhoneNumber,
                                label = "Primary Phone",
                                modifier = Modifier.fillMaxWidth(),
                            )

                            AuntieField(
                                value = state.email,
                                onValueChange = viewModel::updateEditEmail,
                                label = "Email",
                                modifier = Modifier.fillMaxWidth(),
                            )

                            AuntieField(
                                value = state.outstandingBalance,
                                onValueChange = viewModel::updateEditOutstandingBalance,
                                label = "Outstanding Balance",
                                modifier = Modifier.fillMaxWidth(),
                            )

                            // Household tags, vocabulary-backed. Replaces the raw
                            // "Tags (comma-separated)" box: the operator now picks
                            // from the managed list (or promotes a new name into it)
                            // instead of remembering how they spelled it last time.
                            // The form still holds a CSV string, so the field reads
                            // and writes through the bridge helpers below.
                            AuntieFieldLabel(text = "HOUSEHOLD TAGS")
                            TagAssignField(
                                value = editTagsFromField(state.tags),
                                vocab = householdVocab,
                                onChange = { next -> viewModel.updateEditTags(editTagsToField(next)) },
                                onCreateVocab = { name -> promoteHouseholdTag(name) },
                                inputLabel = "Add a household tag",
                                modifier = Modifier.fillMaxWidth(),
                            )
                            vocabError?.let { message ->
                                AuntieBanner(
                                    tone = AuntieBannerTone.Warning,
                                    title = "Tag suggestions unavailable",
                                ) {
                                    Text(
                                        message,
                                        style = AuntieTheme.typography.bodySmall,
                                        color = AuntieTheme.colors.textDim,
                                    )
                                }
                            }

                            // Prospect-aware segmented status picker
                            Text(
                                "STATUS",
                                style = AuntieTheme.typography.labelSmall,
                                color = AuntieTheme.colors.textDim,
                            )
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp),
                            ) {
                                listOf("active", "prospect", "inactive", "archived").forEach { option ->
                                    AuntieChip(
                                        selected = state.status.equals(option, ignoreCase = true),
                                        onClick  = { viewModel.updateEditStatus(option) },
                                        label    = option.replaceFirstChar { it.uppercaseChar() },
                                        modifier = Modifier.weight(1f),
                                    )
                                }
                            }
                        }
                    }
                }

                // Contact & Preferences
                item {
                    AuntieCard(modifier = Modifier.fillMaxWidth()) {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            Text(
                                "OTHER CONTACTS",
                                style = AuntieTheme.typography.labelSmall,
                                color = AuntieTheme.colors.kinfolkOrange
                            )

                            // Run 4: emergency contact lives here (first), not under Identity.
                            AuntieField(
                                value = state.emergencyContactName,
                                onValueChange = viewModel::updateEditEmergencyContactName,
                                label = "Emergency Contact Name *",
                                isError = state.emergencyContactName.isBlank(),
                                modifier = Modifier.fillMaxWidth(),
                            )
                            AuntieField(
                                value = state.emergencyContactPhone,
                                onValueChange = viewModel::updateEditEmergencyContactPhone,
                                label = "Emergency Contact Phone *",
                                isError = !isValidPhone(state.emergencyContactPhone),
                                modifier = Modifier.fillMaxWidth(),
                            )
                            AuntieField(
                                value = state.emergencyContactRelation,
                                onValueChange = viewModel::updateEditEmergencyContactRelation,
                                label = "Emergency Contact Relationship",
                                modifier = Modifier.fillMaxWidth(),
                            )

                            AuntieField(
                                value = state.secondaryPhone,
                                onValueChange = viewModel::updateEditSecondaryPhone,
                                label = "Secondary Phone",
                                modifier = Modifier.fillMaxWidth(),
                            )

                            AuntieField(
                                value = state.secondaryEmail,
                                onValueChange = viewModel::updateEditSecondaryEmail,
                                label = "Secondary Email",
                                modifier = Modifier.fillMaxWidth(),
                            )

                            // item 2: Preferred contact method + Best time to contact
                            // editor removed (Auntie complaint). Model fields preserved
                            // (round-tripped through save), no longer authored here.

                            // item 3: service address lives under Identity + is required.
                            AddressAutofillField(viewModel = viewModel, state = state)
                            if (state.serviceAddress.isBlank()) {
                                Text(
                                    "Service address is required.",
                                    style = AuntieTheme.typography.labelSmall,
                                    color = AuntieTheme.colors.error,
                                    modifier = Modifier.padding(top = 4.dp),
                                )
                            }
                        }
                    }
                }

                // Home & Access
                item {
                    AuntieCard(modifier = Modifier.fillMaxWidth()) {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            Text(
                                "HOME & ACCESS",
                                style = AuntieTheme.typography.labelSmall,
                                color = AuntieTheme.colors.kinfolkOrange
                            )

                            AuntieField(
                                value = state.gateCode,
                                onValueChange = viewModel::updateEditGateCode,
                                label = "Gate Code",
                                modifier = Modifier.fillMaxWidth(),
                            )

                            AuntieField(
                                value = state.parkingInstructions,
                                onValueChange = viewModel::updateEditParkingInstructions,
                                label = "Parking Instructions",
                                modifier = Modifier.fillMaxWidth(),
                                singleLine = false,
                                minLines = 2,
                            )

                            AuntieField(
                                value = state.entryNotes,
                                onValueChange = viewModel::updateEditEntryNotes,
                                label = "Entry Notes",
                                modifier = Modifier.fillMaxWidth(),
                                singleLine = false,
                                minLines = 2,
                            )

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                AuntieField(
                                    value = state.wifiName,
                                    onValueChange = viewModel::updateEditWifiName,
                                    label = "WiFi Name",
                                    modifier = Modifier.weight(1f),
                                )
                                AuntieField(
                                    value = state.wifiPassword,
                                    onValueChange = viewModel::updateEditWifiPassword,
                                    label = "WiFi Password",
                                    modifier = Modifier.weight(1f),
                                )
                            }
                        }
                    }
                }

                // Vet Clinic (household-level, shared catalog)
                item {
                    val vetClinics by viewModel.vetClinicsFlow.collectAsState()
                    AuntieCard(modifier = Modifier.fillMaxWidth()) {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            Text(
                                "VET CLINIC",
                                style = AuntieTheme.typography.labelSmall,
                                color = AuntieTheme.colors.kinfolkOrange
                            )
                            VetClinicSearchField(
                                query = state.vetClinicName,
                                onQueryChange = viewModel::updateEditVetClinicName,
                                clinics = vetClinics,
                                onPick = viewModel::selectVetClinic,
                                onCreate = { name ->
                                    viewModel.createVetClinicFromSearch(name = name)
                                },
                            )
                            AuntieField(
                                value = state.vetClinicPhone,
                                onValueChange = viewModel::updateEditVetClinicPhone,
                                label = "Clinic Phone",
                                modifier = Modifier.fillMaxWidth(),
                            )
                            AuntieField(
                                value = state.vetClinicAddress,
                                onValueChange = viewModel::updateEditVetClinicAddress,
                                label = "Clinic Address",
                                modifier = Modifier.fillMaxWidth(),
                                singleLine = false,
                                minLines = 2,
                            )
                        }
                    }
                }
                // Emergency vet (24 hour), a SECOND picker over the same bank
                // filtered to the flagged clinics. A daytime practice in this
                // slot is worse than a blank one: it reads as an answer at 2am
                // and is not.
                item {
                    val vetClinics by viewModel.vetClinicsFlow.collectAsState()
                    val erClinics = emergencyVetClinics(vetClinics)
                    AuntieCard(modifier = Modifier.fillMaxWidth()) {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            Text(
                                "EMERGENCY VET",
                                style = AuntieTheme.typography.labelSmall,
                                color = AuntieTheme.colors.kinfolkOrange
                            )
                            VetClinicSearchField(
                                query = state.emergencyVetClinicName,
                                onQueryChange = viewModel::updateEditEmergencyVetClinicName,
                                clinics = erClinics,
                                onPick = viewModel::selectEmergencyVetClinic,
                                onCreate = { name ->
                                    // Created already flagged, so it shows up in
                                    // this picker for the next household too.
                                    viewModel.createVetClinicFromSearch(
                                        name = name,
                                        isEmergency = true,
                                        forEmergencySlot = true,
                                    )
                                },
                                emptyCatalogLabel = "Clinic Name (no 24 hour clinics yet)",
                            )
                            if (state.emergencyVetClinicPhone.isNotBlank() ||
                                state.emergencyVetClinicAddress.isNotBlank()
                            ) {
                                Text(
                                    listOf(state.emergencyVetClinicPhone, state.emergencyVetClinicAddress)
                                        .filter { it.isNotBlank() }.joinToString(" · "),
                                    style = AuntieTheme.typography.bodySmall,
                                    color = AuntieTheme.colors.textDim,
                                )
                            }
                        }
                    }
                }

                // Admin & Relationship
                item {
                    AuntieCard(modifier = Modifier.fillMaxWidth()) {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            Text(
                                "ADMIN & RELATIONSHIP",
                                style = AuntieTheme.typography.labelSmall,
                                color = AuntieTheme.colors.kinfolkOrange
                            )

                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(8.dp)
                            ) {
                                AuntieField(
                                    value = state.referralSource,
                                    onValueChange = viewModel::updateEditReferralSource,
                                    label = "Referral Source",
                                    modifier = Modifier.weight(1f),
                                )
                                JoinDateField(
                                    value = state.joinDate,
                                    onClick = { showJoinDatePicker = true },
                                    modifier = Modifier.weight(1f),
                                )
                            }

                            // What the document still holds, when the picker could
                            // not open it. Shown rather than swallowed, so clearing
                            // a legacy value is always a choice, never a surprise.
                            state.joinDateNote?.let { note ->
                                Text(
                                    note,
                                    style = AuntieTheme.typography.bodySmall,
                                    color = AuntieTheme.colors.textDim,
                                )
                            }
                        }
                    }
                }

                // Internal Notes
                item {
                    AuntieCard(modifier = Modifier.fillMaxWidth()) {
                        Column(
                            modifier = Modifier.padding(16.dp),
                            verticalArrangement = Arrangement.spacedBy(12.dp)
                        ) {
                            Text(
                                "INTERNAL NOTES",
                                style = AuntieTheme.typography.labelSmall,
                                color = AuntieTheme.colors.kinfolkOrange
                            )

                            AuntieField(
                                value = state.internalNotes,
                                onValueChange = viewModel::updateEditInternalNotes,
                                label = "Internal Notes",
                                modifier = Modifier.fillMaxWidth(),
                                singleLine = false,
                                minLines = 3,
                            )
                        }
                    }
                }

                // Custom fields (admin-authored KINFOLK form_schemas, Phase 14). Only
                // shown when a KINFOLK schema exists or a load failed; answers persist
                // into Kinfolk.formValues.
                if (state.kinfolkSchemas.isNotEmpty() || state.schemaError != null) {
                    item {
                        AuntieCard(modifier = Modifier.fillMaxWidth()) {
                            Column(
                                modifier = Modifier.padding(16.dp),
                                verticalArrangement = Arrangement.spacedBy(12.dp)
                            ) {
                                Text(
                                    "CUSTOM FIELDS",
                                    style = AuntieTheme.typography.labelSmall,
                                    color = AuntieTheme.colors.kinfolkOrange
                                )
                                when {
                                    // Fail loud: surface a schema load failure, never swallow it.
                                    state.schemaError != null -> Text(
                                        "Couldn't load the custom fields: ${state.schemaError}",
                                        style = AuntieTheme.typography.bodySmall,
                                        color = AuntieTheme.colors.error,
                                    )
                                    else -> DynamicFormFields(
                                        schemas = state.kinfolkSchemas,
                                        values = state.formValues,
                                        onValueChange = viewModel::updateEditKinfolkFormValue,
                                    )
                                }
                            }
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
                        onClick   = viewModel::saveKinfolkChanges,
                        text      = "Save Changes",
                        isLoading = state.isSaving,
                        modifier  = Modifier.fillMaxWidth(),
                        // item 3: service address + emergency name/phone are required.
                        enabled   = state.firstName.isNotBlank() && isValidPhone(state.phoneNumber) &&
                            phoneOkOrBlank(state.secondaryPhone) &&
                            emailOkOrBlank(state.email) && emailOkOrBlank(state.secondaryEmail) &&
                            state.serviceAddress.isNotBlank() &&
                            state.emergencyContactName.isNotBlank() && isValidPhone(state.emergencyContactPhone)
                    )
                }
            }
        }
    }

    if (showJoinDatePicker) {
        JoinDatePickerDialog(
            current = state.joinDate,
            onDismiss = { showJoinDatePicker = false },
            onPick = { iso ->
                viewModel.updateEditJoinDate(iso)
                showJoinDatePicker = false
            },
        )
    }

    // Archive Confirmation Dialog (reversible - matches web ArchiveBlock semantics)
    if (showArchiveDialog) {
        AuntieModal(
            onDismissRequest = { showArchiveDialog = false; archiveReason = "" },
            title = "Archive Kinfolk",
            confirmButton = {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(AuntieTheme.colors.warning)
                        .clickable {
                            viewModel.archiveKinfolk(archiveReason)
                            showArchiveDialog = false
                            archiveReason = ""
                        }
                        .padding(horizontal = 18.dp, vertical = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("Archive", style = AuntieTheme.typography.labelLarge, color = Color.White)
                }
            },
            dismissButton = {
                AuntieTextBtn(onClick = { showArchiveDialog = false; archiveReason = "" }) {
                    Text("Cancel")
                }
            }
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Hide this Kinfolk from active lists. Reversible - unarchive any time from the top-right icon.")
                AuntieField(
                    value         = archiveReason,
                    onValueChange = { archiveReason = it },
                    label         = "Reason (optional)",
                    placeholder   = "e.g. moved away, paused service",
                    singleLine    = false,
                    minLines      = 2,
                )
            }
        }
    }
}

/**
 * The join date as a tappable field: a label, a bordered box, and the stored day
 * rendered for the operator's locale. Matches the DateField the Coverage Package
 * builder already uses, so the two date surfaces read the same.
 *
 * It is not an [AuntieField] any more, and that is the point of the change: the
 * field was free text, so the collection filled up with ISO instants and typed
 * formats nobody can rely on. Tapping opens the calendar; the only value this can
 * now produce is one real day.
 */
@Composable
private fun JoinDateField(value: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = AuntieTheme.colors
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("JOIN DATE", style = AuntieTheme.typography.labelSmall, color = c.textDim)
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .border(1.dp, c.border, RoundedCornerShape(8.dp))
                .clickable(onClick = onClick)
                .padding(horizontal = 12.dp, vertical = 12.dp),
        ) {
            Text(
                if (value.isBlank()) "Pick a date" else formatJoinDate(value),
                style = AuntieTheme.typography.bodyMedium,
                color = if (value.isBlank()) c.textFaint else c.textPrimary,
            )
        }
    }
}

/** The calendar itself. Confirming hands back a `YYYY-MM-DD` day, never an instant. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun JoinDatePickerDialog(current: String, onDismiss: () -> Unit, onPick: (String) -> Unit) {
    // UTC throughout, in and out: the picker's millis are a UTC midnight, so
    // reading them back in the device zone is what slides a date to the day
    // before. Same convention as NewBookingRequestDialog and CoveragePackage.
    val initial = runCatching { LocalDate.parse(current) }.getOrNull() ?: LocalDate.now()
    val pickerState = rememberDatePickerState(
        initialSelectedDateMillis = initial.atStartOfDay(ZoneId.of("UTC")).toInstant().toEpochMilli(),
    )
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            AuntieTextBtn(onClick = {
                pickerState.selectedDateMillis?.let { ms ->
                    onPick(Instant.ofEpochMilli(ms).atZone(ZoneId.of("UTC")).toLocalDate().toString())
                } ?: onDismiss()
            }) { Text("OK") }
        },
        dismissButton = { AuntieTextBtn(onClick = onDismiss) { Text("Cancel") } },
    ) { DatePicker(state = pickerState) }
}

@Composable
private fun AddressAutofillField(
    viewModel: DirectoryViewModel,
    state: EditKinfolkUiState,
) {
    val suggestions by viewModel.addressSuggestions.collectAsState()
    val mapboxError by viewModel.addressError.collectAsState()
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        AuntieField(
            value = state.serviceAddress,
            onValueChange = { v ->
                viewModel.updateEditServiceAddress(v)
                viewModel.queryAddressSuggestions(v)
            },
            label = "Service Address",
            modifier = Modifier.fillMaxWidth(),
            singleLine = false,
            minLines = 2,
        )
        if (mapboxError != null) {
            Text(
                "Address lookup error: ${mapboxError ?: ""}",
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.error,
            )
        }
        if (suggestions.isNotEmpty()) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(AuntieTheme.colors.surface),
                verticalArrangement = Arrangement.spacedBy(0.dp),
            ) {
                suggestions.take(5).forEach { s ->
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { viewModel.pickAddressSuggestion(s) }
                            .padding(horizontal = 12.dp, vertical = 10.dp),
                    ) {
                        Text(
                            s.fullAddress.ifBlank { s.name },
                            style = AuntieTheme.typography.bodyMedium,
                            color = AuntieTheme.colors.textPrimary,
                        )
                        if (s.placeFormatted.isNotBlank()) {
                            Text(
                                s.placeFormatted,
                                style = AuntieTheme.typography.bodySmall,
                                color = AuntieTheme.colors.textDim,
                            )
                        }
                    }
                }
            }
        }
    }
}
// ─────────────────────────────────────────────────────────────────────────────
// The edit form's tag bridge (2026-07-19 Tags port)
//
// [EditKinfolkUiState.tags] is still a comma-separated String and
// DirectoryViewModel still splits it on save, so the vocabulary-backed field
// reads and writes through that shape rather than the form growing a second
// source of truth. These two are inverses for any name without a comma.
//
// The right end state is EditKinfolkUiState holding a List<String> (which also
// removes the comma caveat below). That is a DirectoryViewModel change, not a
// screen one.
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The form's CSV as the name list the assign field shows: split on commas, trim,
 * drop blanks, and dedupe case-insensitively through [addAssigned].
 *
 * The dedupe matters for legacy values. The old editor was raw text and could
 * hold "vip, VIP"; the vocabulary treats those as ONE tag, so the field shows the
 * first spelling rather than two chips that mean the same thing. Pure; tested.
 */
internal fun editTagsFromField(csv: String): List<String> =
    csv.split(",").fold(emptyList<String>()) { acc, raw -> addAssigned(acc, raw) }
/**
 * The name list back as the CSV the form and the ViewModel expect.
 *
 * A comma inside a name cannot survive a CSV round-trip, so it becomes a space
 * here: that keeps ONE tag and shows the operator the result in the chip
 * straight away, instead of quietly turning into two tags at save time. Pure;
 * tested.
 */
internal fun editTagsToField(names: List<String>): String =
    names.joinToString(", ") { normalizeTagName(it.replace(',', ' ')) }
/**
 * The vet-clinic search field: a text box whose dropdown lists matches from the
 * shared `vet_clinics` bank, with a CREATE button pinned at the very bottom.
 *
 * The pinned button is the point (operator issue #13: "there is a button at the
 * very bottom of the dropdown for them to create a vet clinic"). It is present
 * whenever anything has been typed, INCLUDING when nothing matched, which is
 * exactly when an operator needs it. The old panel only offered "Add to shared
 * catalog" below the address field, well past the fold, and only after the whole
 * form had been filled in, so the moment the operator discovered the clinic was
 * missing was not the moment they could do anything about it.
 *
 * The create path goes through `submitVetClinic`, which dedupes on a normalized
 * name and returns the existing id on a match, so pressing it for a clinic the
 * bank already holds selects that record rather than writing a duplicate.
 *
 * Divergence from the web picker, deliberate: web forbids free text entirely
 * (its value is always a catalog row). Here the text box still doubles as the
 * stored clinic name, because every household on this app's Firestore holds
 * exactly that and Compose has no equivalent of the web chip-plus-clear
 * affordance on this screen yet. Selecting a suggestion or creating one stamps
 * `vetClinicId`; typing alone leaves it blank, which readers already treat as
 * "not linked to the catalog".
 */
@Composable
internal fun VetClinicSearchField(
    query: String,
    onQueryChange: (String) -> Unit,
    clinics: List<com.tribetails.auntieos.data.model.VetClinic>,
    onPick: (com.tribetails.auntieos.data.model.VetClinic) -> Unit,
    onCreate: (String) -> Unit,
    emptyCatalogLabel: String = "Clinic Name",
) {
    val matches = vetClinicSuggestions(query, clinics)
    val exact = clinics.any { it.name.equals(query.trim(), ignoreCase = true) }
    val offerCreate = shouldOfferVetClinicCreate(query, clinics) && !exact
    AuntieField(
        value = query,
        onValueChange = onQueryChange,
        label = if (clinics.isEmpty()) emptyCatalogLabel
                else "Clinic Name (type to search ${clinics.size})",
        modifier = Modifier.fillMaxWidth(),
    )
    if (matches.isNotEmpty() || offerCreate) {
        Column(
            Modifier
                .fillMaxWidth()
                .padding(top = 6.dp)
                .background(AuntieTheme.colors.surface2, RoundedCornerShape(12.dp)),
        ) {
            if (!exact) {
                matches.forEach { clinic ->
                    val detail = listOf(clinic.phone, clinic.address)
                        .filter { it.isNotBlank() }.joinToString(" · ")
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .clickable { onPick(clinic) }
                            .padding(horizontal = 14.dp, vertical = 10.dp),
                    ) {
                        Text(
                            clinic.name,
                            style = AuntieTheme.typography.bodyMedium,
                            color = AuntieTheme.colors.textPrimary,
                        )
                        if (detail.isNotBlank()) {
                            Text(
                                detail,
                                style = AuntieTheme.typography.bodySmall,
                                color = AuntieTheme.colors.textDim,
                            )
                        }
                    }
                }
                if (matches.isEmpty()) {
                    Text(
                        "No clinic in the catalog matches that.",
                        style = AuntieTheme.typography.bodySmall,
                        color = AuntieTheme.colors.textDim,
                        modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                    )
                }
            }
            if (offerCreate) {
                // LAST, always. Below every match, never above one.
                Text(
                    createVetClinicLabel(query),
                    style = AuntieTheme.typography.bodyMedium,
                    color = AuntieTheme.colors.kinfolkOrange,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onCreate(query) }
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                )
            }
        }
    }
}
