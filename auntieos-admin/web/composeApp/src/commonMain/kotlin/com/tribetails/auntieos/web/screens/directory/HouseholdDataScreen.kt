package com.tribetails.auntieos.web.screens.directory

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import com.tribetails.auntieos.web.observability.rememberReportingScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.House
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.TriangleAlert
import androidx.compose.runtime.collectAsState
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.HouseholdData
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.web.ui.components.AuntieKeyValueRow
import com.tribetails.auntieos.web.ui.components.LoadErrorBanner
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.GlassSurface
import com.tribetails.auntieos.web.ui.components.MultilineField
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.SectionHeader
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.ui.components.StatusToast
import com.tribetails.auntieos.web.ui.components.ToastKind
import androidx.compose.material3.Text
import kotlinx.coroutines.launch

/**
 * Per-kinfolk household dossier extension. Mirrors Android HouseholdDataScreen.
 * Five sections: Veterinary, Household Items, Routines, Emergency & Safety,
 * Service Providers. ~30 free-text fields shared across all pets in a household;
 * the vets are links to the area vet list (#1908 kin-vet).
 *
 * One Firestore doc per kinfolk in `household_data` collection. Lazy-create on
 * first save when none exists.
 *
 * Den redesign (mirrors ui-ideas/auntieos-household-data-2026-05-27.html): each
 * SubsectionLabel section sits in its own glass panel; the header carries
 * breadcrumbs + the House icon. The two SUGGESTION elements from the mockup (a
 * read-only dossier needsMoreSamples context band and a "Last saved" stamp from
 * HouseholdData.updatedAt) are clearly tagged below.
 */
@Composable
fun HouseholdDataScreen(
    kinfolkId: String,
    kinfolkName: String,
    onBack: () -> Unit,
) {
    val client = remember { FirestoreClient() }
    val scope  = rememberReportingScope()

    // Resolve kinfolkName from stream if caller passed blank.
    val kinfolkResult by remember { client.kinfolkStream() }.collectAsState(initial = FirestoreResult.Loading)

    // Read-only reference: the free-text dossier.householdNotes blob, surfaced at the top
    // so an admin can copy details into the structured fields below. Collected via
    // collectAsState (the same way this screen consumes the kinfolk stream) so the live
    // dossier Flow is never blocked. Empty blob => no reference card.
    val dossierResult by remember(kinfolkId) { client.dossierStream(kinfolkId) }.collectAsState(initial = FirestoreResult.Loading)
    val dossierNotes = (dossierResult as? FirestoreResult.Data)?.value?.householdNotes.orEmpty()
    val resolvedName  = remember(kinfolkResult, kinfolkId, kinfolkName) {
        if (kinfolkName.isNotBlank()) kinfolkName
        else (kinfolkResult as? FirestoreResult.Data)
            ?.value
            ?.firstOrNull { it._id == kinfolkId }
            ?.let { "${it.firstName} ${it.lastName}".trim() }
            ?.ifBlank { "Kinfolk" }
            ?: "Kinfolk"
    }

    var loading by remember(kinfolkId) { mutableStateOf(true) }
    var loadError by remember(kinfolkId) { mutableStateOf<String?>(null) }
    // #994: the document as read (null when the read answered and there is none),
    // then as this screen last wrote it. Save diffs the form against it.
    var existing by remember(kinfolkId) { mutableStateOf<HouseholdData?>(null) }
    // Bumped by Retry after a failed read.
    var loadAttempt by remember(kinfolkId) { mutableStateOf(0) }

    // Veterinary (#1908 kin-vet): the household's vets are links to the area
    // vet list, picked from a dropdown and saved the moment they are picked
    // (HouseholdVet.kt). The free-text vet fields are no longer edited here;
    // they are carried untouched by every save and shown read-only while no
    // clinic is linked.
    val clinicsState by remember { client.vetClinicsStream() }.collectAsState(initial = FirestoreResult.Loading)
    val allClinics = (clinicsState as? FirestoreResult.Data)?.value.orEmpty()
    var vetSaving by remember(kinfolkId) { mutableStateOf<HouseholdVetSlot?>(null) }
    var vetError by remember(kinfolkId) { mutableStateOf<Pair<HouseholdVetSlot, String>?>(null) }

    // Household Items
    var foodLocation        by remember(kinfolkId) { mutableStateOf("") }
    var treatLocation       by remember(kinfolkId) { mutableStateOf("") }
    var medicationLocation  by remember(kinfolkId) { mutableStateOf("") }
    var toysLocation        by remember(kinfolkId) { mutableStateOf("") }
    var beddingLocation     by remember(kinfolkId) { mutableStateOf("") }
    var leashesPoopBagsLocation by remember(kinfolkId) { mutableStateOf("") }
    var cleaningSuppliesLocation by remember(kinfolkId) { mutableStateOf("") }

    // Routines
    var householdRules        by remember(kinfolkId) { mutableStateOf("") }
    var preferredWalkRoutes   by remember(kinfolkId) { mutableStateOf("") }
    var neighborhoodHazards   by remember(kinfolkId) { mutableStateOf("") }
    var securitySystemInfo    by remember(kinfolkId) { mutableStateOf("") }
    var thermostatInstructions by remember(kinfolkId) { mutableStateOf("") }
    var lightingPreferences   by remember(kinfolkId) { mutableStateOf("") }

    // Emergency & Safety
    var poisonControlNumber      by remember(kinfolkId) { mutableStateOf("") }
    var emergencyContactsPriority by remember(kinfolkId) { mutableStateOf("") }
    var evacuationPlan           by remember(kinfolkId) { mutableStateOf("") }
    var importantDocumentsLocation by remember(kinfolkId) { mutableStateOf("") }

    // Service Providers
    var groomerName     by remember(kinfolkId) { mutableStateOf("") }
    var groomerPhone    by remember(kinfolkId) { mutableStateOf("") }
    var trainerName     by remember(kinfolkId) { mutableStateOf("") }
    var trainerPhone    by remember(kinfolkId) { mutableStateOf("") }
    var petSitterBackup by remember(kinfolkId) { mutableStateOf("") }
    var dogWalkerBackup by remember(kinfolkId) { mutableStateOf("") }

    var saving       by remember { mutableStateOf(false) }
    var toast        by remember { mutableStateOf("") }
    var toastVisible by remember { mutableStateOf(false) }
    var toastKind    by remember { mutableStateOf(ToastKind.Info) }
    fun showToast(msg: String, kind: ToastKind = ToastKind.Info) {
        toast = msg; toastKind = kind; toastVisible = true
    }

    // Flags a field's label when its current value is blank, so an admin filling in the
    // dossier reference (above) can see at a glance which fields still need content.
    fun fieldLabel(base: String, value: String): String =
        if (value.isBlank()) "$base · empty" else base

    LaunchedEffect(kinfolkId, loadAttempt) {
        loading = true
        when (val r = client.getHouseholdData(kinfolkId)) {
            is WriteResult.Ok -> {
                val data = r.value
                existing = data
                if (data != null) {
                    foodLocation         = data.foodLocation
                    treatLocation        = data.treatLocation
                    medicationLocation   = data.medicationLocation
                    toysLocation         = data.toysLocation
                    beddingLocation      = data.beddingLocation
                    leashesPoopBagsLocation  = data.leashesPoopBagsLocation
                    cleaningSuppliesLocation = data.cleaningSuppliesLocation
                    householdRules       = data.householdRules
                    preferredWalkRoutes  = data.preferredWalkRoutes
                    neighborhoodHazards  = data.neighborhoodHazards
                    securitySystemInfo   = data.securitySystemInfo
                    thermostatInstructions = data.thermostatInstructions
                    lightingPreferences  = data.lightingPreferences
                    poisonControlNumber  = data.poisonControlNumber
                    emergencyContactsPriority = data.emergencyContactsPriority
                    evacuationPlan       = data.evacuationPlan
                    importantDocumentsLocation = data.importantDocumentsLocation
                    groomerName          = data.groomerName
                    groomerPhone         = data.groomerPhone
                    trainerName          = data.trainerName
                    trainerPhone         = data.trainerPhone
                    petSitterBackup      = data.petSitterBackup
                    dogWalkerBackup      = data.dogWalkerBackup
                }
                loadError = null
            }
            is WriteResult.Err -> {
                loadError = r.message
            }
        }
        loading = false
    }

    /**
     * #1908 kin-vet: a pick writes the one link, diffed against the document as
     * read, and becomes the baseline Save diffs against, so Save never sends it
     * again and never puts the old one back.
     */
    fun saveVet(slot: HouseholdVetSlot, clinicId: String) {
        if (vetSaving != null || saving) return
        val loaded = existing
        val edited = withHouseholdVet(loaded, kinfolkId, slot, clinicId)
        vetSaving = slot
        vetError = null
        scope.launch {
            val r = client.saveHouseholdData(loaded, edited)
            vetSaving = null
            when (r) {
                is WriteResult.Ok -> {
                    if (r.value) {
                        val id = loaded?._id?.ifBlank { null } ?: edited._id.ifBlank { kinfolkId }
                        // Only the link is taken from the write: anything else typed
                        // in the form is still the form's, saved by Save.
                        existing = withHouseholdVet(existing ?: loaded, kinfolkId, slot, clinicId).copy(_id = id)
                    }
                    showToast(if (clinicId.isBlank()) "Vet removed." else "Vet saved.", ToastKind.Success)
                }
                is WriteResult.Err -> vetError = slot to "Couldn't save the vet: ${r.message}"
            }
        }
    }
    fun build(): HouseholdData = (existing ?: HouseholdData(kinfolkId = kinfolkId)).copy(
        kinfolkId            = kinfolkId,
        foodLocation         = foodLocation.trim(),
        treatLocation        = treatLocation.trim(),
        medicationLocation   = medicationLocation.trim(),
        toysLocation         = toysLocation.trim(),
        beddingLocation      = beddingLocation.trim(),
        leashesPoopBagsLocation  = leashesPoopBagsLocation.trim(),
        cleaningSuppliesLocation = cleaningSuppliesLocation.trim(),
        householdRules       = householdRules,
        preferredWalkRoutes  = preferredWalkRoutes,
        neighborhoodHazards  = neighborhoodHazards,
        securitySystemInfo   = securitySystemInfo.trim(),
        thermostatInstructions = thermostatInstructions.trim(),
        lightingPreferences  = lightingPreferences.trim(),
        poisonControlNumber  = poisonControlNumber.trim(),
        emergencyContactsPriority = emergencyContactsPriority,
        evacuationPlan       = evacuationPlan,
        importantDocumentsLocation = importantDocumentsLocation.trim(),
        groomerName          = groomerName.trim(),
        groomerPhone         = groomerPhone.trim(),
        trainerName          = trainerName.trim(),
        trainerPhone         = trainerPhone.trim(),
        petSitterBackup      = petSitterBackup.trim(),
        dogWalkerBackup      = dogWalkerBackup.trim(),
    )

    ScreenScaffold {
        SectionHeader(
            title    = "$resolvedName Household",
            subtitle = "Shared dossier across all pets in this home - vet, locations, routines",
            icon     = Lucide.House,
            breadcrumbs = listOf("Directory", "Kinfolk", resolvedName, "Household"),
        )
        StatusToast(visible = toastVisible, message = toast, kind = toastKind, onDismiss = { toastVisible = false })

        if (loading) {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                repeat(5) { ShimmerCard(height = 120.dp) }
            }
            return@ScreenScaffold
        }
        // #994: a failed read shows no form and no Save. Saving over a read that
        // never answered would have written blanks over the household's data.
        loadError?.let { msg ->
            LoadErrorBanner("Couldn't load household data", msg, onRetry = { loadAttempt++ })
            return@ScreenScaffold
        }

        // SUGGESTION: read-only dossier needsMoreSamples context band. This banner
        // lives on KinfolkProfileScreen, surfaced here as helpful context for the
        // auntie filling the form. Copy is the VERBATIM string from that screen.
        AuntieBanner(
            tone = AuntieBannerTone.Warning,
            icon = Lucide.TriangleAlert,
            pillLabel = "Suggestion",
        ) {
            Text(
                text = "Not enough comms history yet to summarize this kinfolk. Send/receive a few more messages.",
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textPrimary,
            )
        }
        Spacer(Modifier.height(16.dp))

        // Read-only dossier reference. Renders only when the blob is non-blank. The admin
        // copies details into the fields below, then clears the blob on the profile screen.
        if (dossierNotes.isNotBlank()) {
            SectionPanel {
                SubsectionLabel("From dossier (reference)")
                Text(
                    "Admin only / internal. Copy details into the fields below, then clear it on the profile.",
                    style = AuntieTheme.typography.labelSmall,
                    color = AuntieTheme.colors.textDim,
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    dossierNotes,
                    style = AuntieTheme.typography.bodyMedium,
                    color = AuntieTheme.colors.textPrimary,
                )
            }
            Spacer(Modifier.height(16.dp))
        }

        SectionPanel {
            SubsectionLabel("Veterinary Information")
            for (slot in HouseholdVetSlot.entries) {
                if (slot == HouseholdVetSlot.EMERGENCY) Spacer(Modifier.height(16.dp))
                VetClinicPicker(
                    label = if (slot == HouseholdVetSlot.PRIMARY) "Household vet" else "Emergency vet",
                    clinicsState = clinicsState,
                    options = householdVetOptions(allClinics, slot),
                    allClinics = allClinics,
                    selectedId = householdVetClinicId(existing, slot),
                    onPick = { saveVet(slot, it) },
                    allowRemove = true,
                    busy = vetSaving == slot,
                    error = vetError?.takeIf { it.first == slot }?.second,
                    emptyText = if (slot == HouseholdVetSlot.PRIMARY) "No household vet on file yet" else "No emergency vet on file yet",
                )
                val legacy = legacyHouseholdVetLines(existing, slot)
                if (legacy.isNotEmpty()) {
                    Spacer(Modifier.height(8.dp))
                    AuntieFieldLabel(text = "On file before the vet list")
                    legacy.forEach { (label, value) -> AuntieKeyValueRow(label = label, value = value) }
                }
            }
        }
        Spacer(Modifier.height(16.dp))
        SectionPanel {
            SubsectionLabel("Household Items & Locations")
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                BottomBorderField(foodLocation,  { foodLocation  = it }, label = fieldLabel("Food", foodLocation),   modifier = Modifier.weight(1f))
                BottomBorderField(treatLocation, { treatLocation = it }, label = fieldLabel("Treats", treatLocation), modifier = Modifier.weight(1f))
            }
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                BottomBorderField(medicationLocation, { medicationLocation = it }, label = fieldLabel("Medications", medicationLocation), modifier = Modifier.weight(1f))
                BottomBorderField(toysLocation,       { toysLocation       = it }, label = fieldLabel("Toys", toysLocation),        modifier = Modifier.weight(1f))
            }
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                BottomBorderField(beddingLocation,         { beddingLocation         = it }, label = fieldLabel("Bedding", beddingLocation),         modifier = Modifier.weight(1f))
                BottomBorderField(leashesPoopBagsLocation, { leashesPoopBagsLocation = it }, label = fieldLabel("Leashes & bags", leashesPoopBagsLocation),  modifier = Modifier.weight(1f))
            }
            Spacer(Modifier.height(12.dp))
            BottomBorderField(cleaningSuppliesLocation, { cleaningSuppliesLocation = it }, label = fieldLabel("Cleaning supplies location", cleaningSuppliesLocation), modifier = Modifier.fillMaxWidth())
        }
        Spacer(Modifier.height(16.dp))

        SectionPanel {
            SubsectionLabel("Routines & Preferences")
            MultilineField(householdRules,       { householdRules       = it }, label = fieldLabel("Household rules", householdRules),          minLines = 3)
            Spacer(Modifier.height(12.dp))
            MultilineField(preferredWalkRoutes,  { preferredWalkRoutes  = it }, label = fieldLabel("Preferred walk routes", preferredWalkRoutes),    minLines = 2)
            Spacer(Modifier.height(12.dp))
            MultilineField(neighborhoodHazards,  { neighborhoodHazards  = it }, label = fieldLabel("Neighborhood hazards", neighborhoodHazards),     minLines = 2)
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                BottomBorderField(securitySystemInfo,    { securitySystemInfo    = it }, label = fieldLabel("Security system", securitySystemInfo), modifier = Modifier.weight(1f))
                BottomBorderField(thermostatInstructions, { thermostatInstructions = it }, label = fieldLabel("Thermostat", thermostatInstructions),    modifier = Modifier.weight(1f))
            }
            Spacer(Modifier.height(12.dp))
            BottomBorderField(lightingPreferences, { lightingPreferences = it }, label = fieldLabel("Lighting preferences", lightingPreferences), modifier = Modifier.fillMaxWidth())
        }
        Spacer(Modifier.height(16.dp))

        SectionPanel {
            SubsectionLabel("Emergency & Safety")
            BottomBorderField(poisonControlNumber, { poisonControlNumber = it }, label = fieldLabel("Poison control number", poisonControlNumber), modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(12.dp))
            MultilineField(emergencyContactsPriority, { emergencyContactsPriority = it }, label = fieldLabel("Emergency contacts priority", emergencyContactsPriority), minLines = 2)
            Spacer(Modifier.height(12.dp))
            MultilineField(evacuationPlan,            { evacuationPlan            = it }, label = fieldLabel("Evacuation plan", evacuationPlan),             minLines = 2)
            Spacer(Modifier.height(12.dp))
            BottomBorderField(importantDocumentsLocation, { importantDocumentsLocation = it }, label = fieldLabel("Important documents location", importantDocumentsLocation), modifier = Modifier.fillMaxWidth())
        }
        Spacer(Modifier.height(16.dp))

        SectionPanel {
            SubsectionLabel("Service Providers")
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                BottomBorderField(groomerName,  { groomerName  = it }, label = fieldLabel("Groomer name", groomerName),  modifier = Modifier.weight(1f))
                BottomBorderField(groomerPhone, { groomerPhone = it }, label = fieldLabel("Groomer phone", groomerPhone), modifier = Modifier.weight(1f))
            }
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                BottomBorderField(trainerName,  { trainerName  = it }, label = fieldLabel("Trainer name", trainerName),  modifier = Modifier.weight(1f))
                BottomBorderField(trainerPhone, { trainerPhone = it }, label = fieldLabel("Trainer phone", trainerPhone), modifier = Modifier.weight(1f))
            }
            Spacer(Modifier.height(12.dp))
            BottomBorderField(petSitterBackup, { petSitterBackup = it }, label = fieldLabel("Backup pet sitter", petSitterBackup), modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(12.dp))
            BottomBorderField(dogWalkerBackup, { dogWalkerBackup = it }, label = fieldLabel("Backup dog walker", dogWalkerBackup), modifier = Modifier.fillMaxWidth())
        }
        Spacer(Modifier.height(28.dp))

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            GhostButton(label = "Back", onClick = onBack, modifier = Modifier.weight(1f))
            PrimaryButton(
                label   = "Save Household Data",
                enabled = !saving && vetSaving == null && !loading && loadError == null,
                loading = saving,
                onClick = save@{
                    if (loading || loadError != null) return@save
                    saving = true
                    val loaded = existing
                    val edited = build()
                    scope.launch {
                        val r = client.saveHouseholdData(loaded, edited)
                        saving = false
                        when (r) {
                            is WriteResult.Ok  -> {
                                // What was just written is the next save's baseline.
                                if (r.value) existing = edited.copy(_id = loaded?._id?.ifBlank { null } ?: edited._id.ifBlank { kinfolkId })
                                showToast(if (r.value) "Saved." else "No changes to save.", ToastKind.Success)
                            }
                            is WriteResult.Err -> showToast("Save failed: ${r.message}", ToastKind.Error)
                        }
                    }
                },
                modifier = Modifier.weight(1f),
            )
        }

        // SUGGESTION: surface HouseholdData.updatedAt (model field, not previously
        // shown). Renders only when a saved doc exists with a non-blank timestamp.
        existing?.updatedAt?.takeIf { it.isNotBlank() }?.let { stamp ->
            Spacer(Modifier.height(10.dp))
            Text(
                text  = "Last saved: $stamp",
                style = AuntieTheme.typography.mono,
                color = AuntieTheme.colors.textDim,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/**
 * Den glass panel wrapping one SubsectionLabel section. Mirrors the mockup
 * `.panel` (rounded glass card) so each form section reads as its own surface.
 */
@Composable
private fun SectionPanel(content: @Composable () -> Unit) {
    GlassSurface(cornerRadius = 20.dp, modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.fillMaxWidth().padding(20.dp)) {
            content()
        }
    }
}

@Composable
private fun SubsectionLabel(label: String) {
    val c = AuntieTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(9.dp),
        modifier = Modifier.padding(bottom = 16.dp),
    ) {
        // Mockup `.seclbl::before`: a small brand-tinted dot leading the label.
        Spacer(
            Modifier
                .size(6.dp)
                .clip(CircleShape)
                .background(c.primary),
        )
        Text(
            text  = label.uppercase(),
            style = AuntieTheme.typography.labelSmall,
            color = c.textDim,
        )
    }
}
