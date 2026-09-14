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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.tribetails.auntieos.data.model.TagDef
import com.tribetails.auntieos.data.model.TagScope
import com.tribetails.auntieos.data.model.addAssigned
import com.tribetails.auntieos.data.model.VetClinic
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
                            EmergencyContactsEditor(
                                drafts = state.emergencyContacts,
                                onChange = viewModel::updateEditEmergencyContact,
                                onAdd = viewModel::addEditEmergencyContact,
                                onRemove = viewModel::removeEditEmergencyContact,
                                onMoveFirst = viewModel::moveEditEmergencyContactFirst,
                                enabled = !state.isSaving,
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

                // THE VET SECTION IS GONE, and its absence is the fix.
                //
                // Operator ruling 2026-08-01: "vet info lives on household data,
                // it can be seen on the kin profile" (page-specs 04 item 3).
                // These two pickers wrote eight vetClinic* / emergencyVetClinic*
                // keys onto the kinfolk doc, which is what made that doc a second
                // writable copy of a fact `household_data` already owned, with
                // nothing tying them together and no rule about which was true.
                //
                // The vet is chosen once on Household Data, against the same
                // shared catalog, and shown read-only here and on the kin.
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
                        // item 3: service address is required. Emergency Contacts are
                        // validated by the view model (validateEmergencyContactDrafts),
                        // which names the problem in state.error rather than merely
                        // disabling the button.
                        enabled   = state.firstName.isNotBlank() && isValidPhone(state.phoneNumber) &&
                            phoneOkOrBlank(state.secondaryPhone) &&
                            emailOkOrBlank(state.email) && emailOkOrBlank(state.secondaryEmail) &&
                            state.serviceAddress.isNotBlank()
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
// ─────────────────────────────────────────────────────────────────────────────
// Vet clinic picker
// ─────────────────────────────────────────────────────────────────────────────
/**
 * The household's vet clinic: a search over the curated `vet_clinics` bank whose
 * value is ALWAYS a row in that bank.
 *
 * PARITY WITH WEB (operator ruling, issue #13, 2026-07-25). Typing is a SEARCH
 * and can never on its own produce a saved vet. An earlier revision of this file
 * let the text box double as the stored clinic name and documented that as a
 * deliberate divergence; the operator ruled parity required, and that note was
 * wrong the moment it was written. If free text could stand as the value, a typo
 * would quietly become a fourth spelling of a clinic the bank already holds,
 * which is the exact mess a shared catalog exists to prevent, and it would do it
 * in a catalog the kinfolk portal reads too.
 *
 * THE COMMITTED-SELECTION AFFORDANCE, modelled on [TagAssignField] + [TagChip],
 * which is how this app already expresses "a value that has been committed, and
 * can be taken back": a pill of the brand tone washed over the surface, a
 * hairline border in the same tone, and an [AuntieIconButton] × to remove it,
 * exactly as an assigned tag chip renders. A committed clinic is that chip plus
 * its phone/address line. Search and selection are mutually exclusive states, so
 * while a clinic is committed the text box is GONE rather than merely disabled:
 * a prefilled text box is an invitation to type into it, and that invitation is
 * the thing being removed.
 *
 * LEGACY HOUSEHOLDS. Every household saved before this holds the vet strings and
 * no id. That renders as a perfectly valid committed chip carrying
 * [VET_CLINIC_UNLINKED_NOTE], and it saves back untouched. What is forbidden is
 * creating NEW free-text vets, not displaying old ones, and an operator who
 * opened a legacy record to fix a phone number is never blocked from saving by
 * a vet field they did not touch.
 *
 * @param selection The committed clinic, or [EMPTY_VET_CLINIC_SELECTION].
 * @param clinics The catalog to search. The EMERGENCY instance passes a list
 *   already filtered by [emergencyVetClinics].
 * @param onCreate Receives the clinic to add to the shared catalog. The caller
 *   submits it and selects the result, so a dedupe hit can pick the existing row.
 * @param createAsEmergency Seeds the create form's 24-hour toggle. True for the
 *   emergency instance, so a clinic added there is already flagged.
 */
@Composable
internal fun VetClinicPickerField(
    label: String,
    selection: VetClinicSelection,
    clinics: List<VetClinic>,
    onSelectionChange: (VetClinicSelection) -> Unit,
    onCreate: (VetClinic) -> Unit,
    modifier: Modifier = Modifier,
    createAsEmergency: Boolean = false,
    enabled: Boolean = true,
) {
    val c = AuntieTheme.colors
    var query by remember { mutableStateOf("") }
    var creating by remember { mutableStateOf(false) }
    Column(modifier = modifier.fillMaxWidth()) {
        AuntieFieldLabel(text = label)
        Spacer(Modifier.height(6.dp))
        when {
            creating -> CreateVetClinicForm(
                initialName = query.trim(),
                initialEmergency = createAsEmergency,
                enabled = enabled,
                onCancel = { creating = false },
                onSave = { clinic ->
                    creating = false
                    query = ""
                    onCreate(clinic)
                },
            )
            selection.hasSelection -> CommittedVetClinic(
                selection = selection,
                enabled = enabled,
                onClear = { onSelectionChange(EMPTY_VET_CLINIC_SELECTION) },
            )
            else -> {
                AuntieField(
                    value = query,
                    onValueChange = { query = it },
                    enabled = enabled,
                    placeholder = if (clinics.isEmpty()) "No clinics in the catalog yet"
                                  else "Type to search ${clinics.size} clinics",
                    modifier = Modifier.fillMaxWidth(),
                    fieldModifier = Modifier.semantics { contentDescription = label },
                )
                val matches = vetClinicSuggestions(query, clinics)
                val offerCreate = shouldOfferVetClinicCreate(query, clinics)
                if (matches.isNotEmpty() || offerCreate) {
                    val shape = RoundedCornerShape(12.dp)
                    Spacer(Modifier.height(8.dp))
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(shape)
                            .background(c.surface2)
                            .border(AuntieTheme.dims.borderHairline, SolidColor(c.border), shape)
                            .padding(vertical = 4.dp),
                    ) {
                        matches.forEach { clinic ->
                            VetClinicSuggestionRow(
                                clinic = clinic,
                                onClick = {
                                    query = ""
                                    onSelectionChange(vetClinicSelectionOf(clinic))
                                },
                            )
                        }
                        if (matches.isEmpty() && offerCreate) {
                            Text(
                                "No clinic in the catalog matches that.",
                                style = AuntieTheme.typography.bodySmall,
                                color = c.textDim,
                                modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                            )
                        }
                        if (offerCreate) {
                            // PINNED, always last. Below every match, never above
                            // one, and present when nothing matched at all, which
                            // is the case it exists for.
                            Text(
                                text = createVetClinicLabel(query),
                                style = AuntieTheme.typography.bodyMedium,
                                color = c.primary,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable(enabled = enabled) { creating = true }
                                    .padding(horizontal = 14.dp, vertical = 12.dp),
                            )
                        }
                    }
                }
            }
        }
    }
}
/** One catalog match: the clinic name over its phone and address. */
@Composable
private fun VetClinicSuggestionRow(clinic: VetClinic, onClick: () -> Unit) {
    val c = AuntieTheme.colors
    val detail = vetClinicSelectionOf(clinic).detail
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 10.dp),
    ) {
        Text(clinic.name, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
        if (detail.isNotBlank()) {
            Text(detail, style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
    }
}
/**
 * A clinic that has been chosen: the TagChip idiom (tone wash, hairline border in
 * the same tone, an × that takes it back) grown to carry the clinic's contact
 * line and, for a legacy record, the honest note that it is not joined to the
 * catalog yet.
 */
@Composable
private fun CommittedVetClinic(
    selection: VetClinicSelection,
    enabled: Boolean,
    onClear: () -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val shape = RoundedCornerShape(14.dp)
    // A legacy record is quieter than a linked one: it is a real value, but it is
    // not the curated thing, and the chip should not claim otherwise.
    val tone = if (selection.unlinked) c.textDim else c.primary
    val fillAlpha = if (c.isDark) 0.16f else 0.10f
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(tone.copy(alpha = fillAlpha))
            .border(dims.borderHairline, SolidColor(tone.copy(alpha = 0.45f)), shape)
            .padding(start = 14.dp, end = 4.dp, top = 8.dp, bottom = 10.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = selection.name,
                style = AuntieTheme.typography.bodyMedium,
                color = c.textPrimary,
                modifier = Modifier.weight(1f),
            )
            if (enabled) {
                AuntieIconButton(
                    icon = Lucide.X,
                    contentDescription = "Clear ${selection.name}",
                    onClick = onClear,
                    size = 32.dp,
                    destructive = true,
                )
            }
        }
        if (selection.detail.isNotBlank()) {
            Text(
                text = selection.detail,
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
                modifier = Modifier.padding(end = 10.dp),
            )
        }
        if (selection.unlinked) {
            Spacer(Modifier.height(4.dp))
            Text(
                text = VET_CLINIC_UNLINKED_NOTE,
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
                modifier = Modifier.padding(end = 10.dp),
            )
        }
    }
}
/**
 * The inline "this clinic is not in the bank yet" form.
 *
 * With free text gone this is the ONLY way to record a clinic the catalog lacks,
 * so it collects everything the catalog row needs rather than just a name: an
 * operator who cannot find a clinic must be able to add it, with its phone and
 * address, without leaving the household they are editing. Inline rather than a
 * dialog for the same reason, a sheet over a form is how a half-typed form gets
 * lost.
 */
@Composable
private fun CreateVetClinicForm(
    initialName: String,
    initialEmergency: Boolean,
    enabled: Boolean,
    onCancel: () -> Unit,
    onSave: (VetClinic) -> Unit,
) {
    val c = AuntieTheme.colors
    var name by remember { mutableStateOf(initialName) }
    var phone by remember { mutableStateOf("") }
    var address by remember { mutableStateOf("") }
    var website by remember { mutableStateOf("") }
    var isEmergency by remember { mutableStateOf(initialEmergency) }
    var nameError by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(14.dp)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(c.surface2)
            .border(AuntieTheme.dims.borderHairline, SolidColor(c.border), shape)
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            "Add this clinic to the shared catalog",
            style = AuntieTheme.typography.bodyMedium,
            color = c.textPrimary,
        )
        AuntieField(
            value = name,
            onValueChange = { name = it; nameError = false },
            label = "Clinic name",
            enabled = enabled,
            isError = nameError,
            modifier = Modifier.fillMaxWidth(),
            fieldModifier = Modifier.semantics { contentDescription = "Clinic name" },
        )
        if (nameError) {
            Text(
                "Clinic name can't be blank.",
                style = AuntieTheme.typography.bodySmall,
                color = c.error,
            )
        }
        AuntieField(
            value = phone,
            onValueChange = { phone = it },
            label = "Clinic phone",
            enabled = enabled,
            modifier = Modifier.fillMaxWidth(),
            fieldModifier = Modifier.semantics { contentDescription = "Clinic phone" },
        )
        AuntieField(
            value = address,
            onValueChange = { address = it },
            label = "Clinic address",
            enabled = enabled,
            modifier = Modifier.fillMaxWidth(),
            fieldModifier = Modifier.semantics { contentDescription = "Clinic address" },
        )
        AuntieField(
            value = website,
            onValueChange = { website = it },
            label = "Website",
            enabled = enabled,
            modifier = Modifier.fillMaxWidth(),
            fieldModifier = Modifier.semantics { contentDescription = "Website" },
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            AuntieToggle(
                checked = isEmergency,
                onCheckedChange = { isEmergency = it },
                enabled = enabled,
            )
            Text(
                "24 hour / emergency clinic",
                style = AuntieTheme.typography.bodySmall,
                color = c.textPrimary,
            )
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            GhostButton(label = "Cancel", onClick = onCancel, enabled = enabled)
            PrimaryButton(
                label = "Save clinic",
                enabled = enabled,
                onClick = {
                    if (name.trim().isBlank()) {
                        nameError = true
                        return@PrimaryButton
                    }
                    onSave(
                        VetClinic(
                            name = name.trim(),
                            phone = phone.trim(),
                            address = address.trim(),
                            website = website.trim(),
                            isEmergency = isEmergency,
                        )
                    )
                },
            )
        }
    }
}
