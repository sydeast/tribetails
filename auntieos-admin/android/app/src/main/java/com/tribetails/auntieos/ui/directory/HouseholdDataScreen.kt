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
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.components.LoadingScreen
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * The household record's edit form, matched to
 * `ui-ideas/auntieos-household-data-2026-05-27.html` (#755): the kit hero
 * with the trail and "<Name> Household", three `DenPanel` sections with the
 * mock's titles, and the mock's footer of Back beside Save. The three orange
 * uppercase kickers on plain cards were the pre-kit world.
 *
 * [onDirectory] is the trail's first step, all the way out to the Directory
 * list. [onBack] pops ONE entry, to the household profile this was opened
 * from, which is the trail's second step, so the first needs its own way
 * past that. Defaults to [onBack] so a caller with no deeper stack still gets
 * a step that does something.
 */
@Composable
fun HouseholdDataScreen(
    kinfolkId: String,
    kinfolkName: String,
    viewModel: HouseholdDataViewModel = viewModel(),
    onBack: () -> Unit,
    onDirectory: () -> Unit = onBack,
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
                item {
                    DenScreenHeading(
                        // The trail takes the kicker's place on a nested
                        // screen. Android's Directory tab is already labelled
                        // "Kinfolk", so the mock's separate Kinfolk step would
                        // name a screen that does not exist here.
                        kicker = "The Den · Directory",
                        crumbs = listOf(
                            DenCrumb("Directory", onDirectory),
                            DenCrumb(kinfolkName, onBack),
                            DenCrumb("Household"),
                        ),
                        title = "$kinfolkName Household",
                        subtitle = "The shared record behind this household: vet, supplies and routines, for every pet in the home.",
                    )
                }
                // Phase 2: read-only dossier notes shown as a fill-in reference when present.
                if (state.dossierNotes.isNotBlank()) {
                    item { DossierReferenceCard(state.dossierNotes) }
                }
                item { VeterinaryInfoCard(viewModel, onOpenProfile = onBack) }
                item { HouseholdItemsCard(viewModel) }
                item { RoutinesCard(viewModel) }
                // REMOVED 2026-08-04 (mirrors the React admin, lib/householdDataSchema.ts):
                // EmergencySafetyCard and ServiceProvidersCard. Operator: "I dont need
                // this Emergency & Safety or Service Provider boxes." This is a UI
                // removal only: `HouseholdData` (data/model/DynamicFields.kt) still
                // carries all ten fields and a save cannot touch them, because the
                // save writes only the fields that CHANGED and no card here can
                // change these. (It used to whole-document write them back, which
                // preserved them and reverted concurrent web edits in the same
                // stroke; see HouseholdDataViewModel.saveHouseholdData.) The pending
                // household/family-page redesign's "Emergency Must Knows" section is
                // where the emergency-contact half is headed next; do not delete these
                // fields off the model when you don't see a card using them here.

                // Fail loud, in the kit's banner. The view model's message
                // already says which it was ("Failed to load household data:"
                // or "Failed to save household data:"), so the banner carries
                // no title of its own that could contradict it.
                if (state.error != null) {
                    item {
                        AuntieBanner(tone = AuntieBannerTone.Error) {
                            Text(
                                text = state.error!!,
                                style = AuntieTheme.typography.bodySmall,
                                color = AuntieTheme.colors.textPrimary,
                            )
                        }
                    }
                }

                // The mock's footer: Back and Save side by side, equal widths.
                item {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        GhostButton(
                            label = "Back",
                            onClick = onBack,
                            modifier = Modifier.weight(1f),
                        )
                        PrimaryButton(
                            label = "Save Household Data",
                            onClick = viewModel::saveHouseholdData,
                            loading = state.isSaving,
                            enabled = !state.isSaving,
                            modifier = Modifier.weight(1f),
                        )
                    }
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

/**
 * Phase 2: read-only dossier notes shown as a fill-in reference above the
 * editor fields. "admin only" is a statement about the panel, so it is the
 * mock's right-aligned mono note; the sentence that used to sit under the
 * title is the explanation, so it is the info button's tooltip (#758).
 */
@Composable
private fun DossierReferenceCard(notes: String) {
    DenPanel(
        title = "From the dossier",
        subtitle = "Loose notes written before this record existed. Copy what belongs into the fields below, then clear it on the profile; the dossier keeps its own copy either way.",
        trailing = {
            Text(
                "admin only",
                style = AuntieTheme.typography.mono.copy(fontSize = 11.sp),
                color = AuntieTheme.colors.textDim,
            )
        },
        modifier = Modifier.fillMaxWidth(),
    ) {
        Text(notes, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textPrimary)
    }
}

/**
 * The veterinary card, READ THROUGH from the household profile (punchlist A2).
 *
 * These were seven free-text inputs. That made the vet a second, independent
 * store with no tie to the shared clinic catalog, so this card and the
 * household profile could disagree and neither said so, on the screen a sitter
 * reads the emergency number off under pressure.
 *
 * The kinfolk record wins because only the catalog-linked copy can be
 * CORRECTED: `updateVetClinic` fixes a wrong clinic phone number once and fans
 * it out to every linked household. Free text here inherited nothing, so
 * leaving it authoritative would have meant the number read under pressure was
 * the one copy in the product no correction could ever reach.
 *
 * Hours come from the CLINIC. Every household using a practice shares its
 * opening hours, so `primaryVetHours` (one copy per household, corrected never)
 * is retired in favour of one copy on the catalog row.
 */
@Composable
private fun VeterinaryInfoCard(viewModel: HouseholdDataViewModel, onOpenProfile: () -> Unit) {
    val state by viewModel.uiState.collectAsState()
    val vet = state.vet
    val leftovers = legacyVetLeftovers(state.householdData)
    var confirmingClear by remember { mutableStateOf(false) }
    DenPanel(
        title = "Veterinary Information",
        subtitle = "Who to call, and who to call at 2am. Chosen from the shared vet bank on the household profile.",
        trailing = { GhostButton(label = "Edit on the profile", onClick = onOpenProfile) },
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
            when {
                // Fail loud: an unreadable vet must not look like a household
                // that simply has not chosen one.
                state.vetError != null -> AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    title = "Couldn't load the household's vet",
                ) {
                    Text(state.vetError!!, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
                }
                vet == null -> Text(
                    "Reading the household's vet...",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim,
                )
                else -> {
                    if (!(vet.primary.hasAny || vet.emergency.hasAny)) {
                        Text(
                            "No vet on file for this household. Pick one on the household profile and it appears here.",
                            style = AuntieTheme.typography.bodySmall,
                            color = AuntieTheme.colors.textDim,
                        )
                    }
                    Text("Primary Veterinarian", style = AuntieTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    VetFactRow("Vet Name", vet.primary.name)
                    VetFactRow("Phone", vet.primary.phone)
                    VetFactRow("Hours", vet.primary.hours)
                    VetFactRow("Address", vet.primary.address)
                    // Not an error, but a fact worth stating: with no clinic id
                    // there is nothing for a catalog correction to match on, so
                    // fixing this clinic in the vet bank will not reach here.
                    if (vet.primary.hasAny && !vet.primary.linked) {
                        AuntieBanner(
                            tone = AuntieBannerTone.Warning,
                            title = "This vet is not linked to the catalog",
                        ) {
                            Text(
                                "The name and number above are on file, but no clinic is selected, so correcting this clinic in the vet bank will not update this household. Re-pick it on the profile to link them.",
                                style = AuntieTheme.typography.bodySmall,
                                color = AuntieTheme.colors.textDim,
                            )
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    // The EMERGENCY vet stays a distinct clinic, never folded
                    // into the primary: "who to call" and "who to call at 2am"
                    // are different practices and the whole card exists to keep
                    // them apart.
                    Text("Emergency Veterinarian", style = AuntieTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    VetFactRow("Emergency Vet Name", vet.emergency.name)
                    VetFactRow("Emergency Phone", vet.emergency.phone)
                    VetFactRow("Emergency Hours", vet.emergency.hours)
                    VetFactRow("Emergency Address", vet.emergency.address)
                }
            }
            // Fail loud, never silent: the record still carries the retired free
            // text, so it is shown rather than dropped, and named as superseded
            // rather than presented as a second opinion.
            if (leftovers.isNotEmpty()) {
                AuntieBanner(
                    tone = AuntieBannerTone.Warning,
                    title = "Older vet notes are still on this record",
                ) {
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(
                            "These were typed here before the vet moved to the household profile. They are not used anywhere and are not kept up to date. Whatever is left below can be cleared once you have copied out anything worth keeping.",
                            style = AuntieTheme.typography.bodySmall,
                            color = AuntieTheme.colors.textDim,
                        )
                        leftovers.forEach { (label, value) -> VetFactRow(label, value) }
                        GhostButton(label = "Clear old vet notes", onClick = { confirmingClear = true })
                    }
                }
            }
        }
    }

    // Issue #677: this used to tell the operator to "resolve by hand" with no
    // control anywhere in the admin that could ever touch these fields. This is
    // that control, confirmed before it writes and routed through the same
    // diffed save (`saveHouseholdData`) every other household-data edit uses.
    if (confirmingClear) {
        AuntieModal(
            onDismissRequest = { if (!state.isSaving) confirmingClear = false },
            title = "Clear the old vet notes?",
            confirmButton = {
                PrimaryButton(
                    label = if (state.isSaving) "Clearing..." else "Clear",
                    enabled = !state.isSaving,
                    loading = state.isSaving,
                    onClick = {
                        viewModel.clearLegacyVetLeftovers()
                        confirmingClear = false
                    },
                )
            },
            dismissButton = {
                AuntieTextBtn(onClick = { confirmingClear = false }, enabled = !state.isSaving) {
                    Text("Cancel")
                }
            },
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    "This removes the fields below from this record. The linked vet shown above is unaffected: it lives on the clinic, not here.",
                    style = AuntieTheme.typography.bodyMedium,
                    color = AuntieTheme.colors.textPrimary,
                )
                leftovers.forEach { (label, value) -> VetFactRow(label, value) }
            }
        }
    }
}
/** One read-only label/value line. Blank renders "Not set" rather than hiding. */
@Composable
private fun VetFactRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            label,
            style = AuntieTheme.typography.labelSmall,
            color = AuntieTheme.colors.textDim,
            modifier = Modifier.weight(0.4f),
        )
        Text(
            value.ifBlank { "Not set" },
            style = AuntieTheme.typography.bodySmall,
            color = if (value.isBlank()) AuntieTheme.colors.textFaint else AuntieTheme.colors.textPrimary,
            modifier = Modifier.weight(0.6f),
        )
    }
}
@Composable
private fun HouseholdItemsCard(viewModel: HouseholdDataViewModel) {
    val state by viewModel.uiState.collectAsState()
    val data = state.householdData

    DenPanel(
        title = "Household Items & Locations",
        subtitle = "Where everything lives, so nobody has to open every cupboard.",
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
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

    DenPanel(
        title = "Routines & Preferences",
        subtitle = "How this household runs when Auntie is the one running it.",
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
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

// EmergencySafetyCard and ServiceProvidersCard were removed here 2026-08-04,
// with their `item { }` calls above. `HouseholdDataViewModel` still exposes
// updatePoisonControlNumber / updateGroomerName / etc: they are unused by any
// composable now, not deleted, on the same "field survives, panel doesn't"
// basis as the model fields themselves.
