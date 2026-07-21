package com.tribetails.auntieos.web.screens.directory

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import com.tribetails.auntieos.web.observability.rememberReportingScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.PawPrint
import com.tribetails.auntieos.web.data.CloudFormSchemaRepository
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.FormSchema
import com.tribetails.auntieos.web.data.FormSchemaSummary
import com.tribetails.auntieos.web.data.appliesToSchemaIds
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieAvatar
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieSelectField
import com.tribetails.auntieos.web.ui.components.DynamicFormFields
import com.tribetails.auntieos.web.ui.components.AuntieBreadcrumbs
import com.tribetails.auntieos.web.ui.components.AuntieChip
import com.tribetails.auntieos.web.ui.components.AuntieChipTone
import com.tribetails.auntieos.web.ui.components.AuntieFieldLabel
import com.tribetails.auntieos.web.ui.components.AuntieSaveBar
import com.tribetails.auntieos.web.ui.components.AuntieStatusPill
import com.tribetails.auntieos.web.ui.components.AuntieStatusTone
import com.tribetails.auntieos.web.ui.components.BottomBorderField
import com.tribetails.auntieos.web.ui.components.Crumb
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.GlassSurface
import com.tribetails.auntieos.web.ui.components.MultilineField
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.ShimmerCard
import com.tribetails.auntieos.web.ui.components.StatusToast
import com.tribetails.auntieos.web.ui.components.ToastKind
import com.tribetails.auntieos.web.screens.communicate.SYNTHESIZE_SUCCESS
import kotlinx.coroutines.launch

// item 1/3: controlled vocabularies for the Kin identity dropdowns. "Other" keeps
// rare species enterable without corrupting the set. Run-4 #6: breed is now a
// type-to-search dropdown over the seeded dog/cat banks (free-text fallback).
private val SPECIES_OPTIONS = listOf("Dog", "Cat", "Bird", "Rabbit", "Reptile", "Small mammal", "Other")
private val GENDER_OPTIONS = listOf("Male", "Female", "Unknown")

/** Ids of the form_schemas placed on KIN (appliesTo == KIN). Pure; unit-tested. */
internal fun kinSchemaIds(summaries: List<FormSchemaSummary>): List<String> =
    appliesToSchemaIds(summaries, "KIN")

/** Add/edit a Kin under a given Kinfolk. */
@Composable
fun KinEditScreen(
    kinfolkId: String,
    kinId: String?,
    onBack: () -> Unit,
    onSaved: (kinId: String) -> Unit,
    onArchived: () -> Unit,
) {
    val client = remember { FirestoreClient() }
    val scope  = rememberReportingScope()
    val isNew  = kinId.isNullOrBlank()

    val state by remember(kinfolkId) { client.kinStream(kinfolkId) }.collectAsState(initial = FirestoreResult.Loading)
    val existing: Kin? = remember(state, kinId) {
        if (isNew) null
        else (state as? FirestoreResult.Data)?.value?.firstOrNull { it._id == kinId }
    }

    // Vet is single-source on the owning Kinfolk (household); the Kin shows it
    // READ-ONLY (spec 06 item 2 / 04 item 3). Fetch the parent Kinfolk for its vet.
    val kinfolkState by remember { client.kinfolkStream() }.collectAsState(initial = FirestoreResult.Loading)
    val parentKinfolk = remember(kinfolkState, kinfolkId) {
        (kinfolkState as? FirestoreResult.Data)?.value?.firstOrNull { it._id == kinfolkId }
    }

    var initialized by remember(kinId) { mutableStateOf(false) }

    var name           by remember(kinId) { mutableStateOf("") }
    var species        by remember(kinId) { mutableStateOf("Dog") }
    var breed          by remember(kinId) { mutableStateOf("") }
    var age            by remember(kinId) { mutableStateOf("") }
    var sex            by remember(kinId) { mutableStateOf("") }
    var weight         by remember(kinId) { mutableStateOf("") }
    var colorMarkings  by remember(kinId) { mutableStateOf("") }
    var spayedNeutered by remember(kinId) { mutableStateOf(false) }
    var reactive       by remember(kinId) { mutableStateOf(false) }
    var routine        by remember(kinId) { mutableStateOf("") }
    var trainingCmds   by remember(kinId) { mutableStateOf("") }
    var feedingBrand   by remember(kinId) { mutableStateOf("") }
    var vaccinations   by remember(kinId) { mutableStateOf("") }
    var medsHealth     by remember(kinId) { mutableStateOf("") }
    var checklist      by remember(kinId) { mutableStateOf("") }
    var staysAs        by remember(kinId) { mutableStateOf("") }
    var officeNotes    by remember(kinId) { mutableStateOf("") }
    var photoUrl       by remember(kinId) { mutableStateOf("") }

    // ---- Dynamic KIN form_schemas (spec 06 item 5 / 1C): the precare checklist is
    // structured, schema-driven fields, not a free-text blob. Load every schema
    // placed on KIN, render its fields, and persist answers into Kin.formValues.
    val formValues = remember(kinId) { mutableStateMapOf<String, String>() }
    val schemaRepo = remember { CloudFormSchemaRepository() }
    var kinSchemas  by remember { mutableStateOf<List<FormSchema>>(emptyList()) }
    var schemaError by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) {
        when (val list = schemaRepo.listSchemas()) {
            is WriteResult.Err -> schemaError = list.message
            is WriteResult.Ok  -> {
                val loaded = mutableListOf<FormSchema>()
                for (id in kinSchemaIds(list.value)) {
                    when (val s = schemaRepo.getSchema(id)) {
                        is WriteResult.Ok  -> loaded.add(s.value)
                        is WriteResult.Err -> schemaError = s.message
                    }
                }
                kinSchemas = loaded
            }
        }
    }

    // Run-4 #6: seeded dog/cat breed banks for the breed dropdown. A load failure or
    // the desktop callable stub leaves the banks empty -> the field degrades to
    // free-text with a disclosed note (never a silent empty dropdown, never faked).
    var dogBreeds by remember { mutableStateOf<List<String>>(emptyList()) }
    var catBreeds by remember { mutableStateOf<List<String>>(emptyList()) }
    LaunchedEffect(Unit) {
        when (val r = client.breeds()) {
            is WriteResult.Ok  -> { dogBreeds = r.value.dogBreeds; catBreeds = r.value.catBreeds }
            is WriteResult.Err -> { dogBreeds = emptyList(); catBreeds = emptyList() }
        }
    }

    LaunchedEffect(existing, isNew) {
        if (!isNew && existing != null && !initialized) {
            name           = existing.name
            species        = existing.species
            breed          = existing.breed
            age            = existing.age
            sex            = existing.sex
            weight         = existing.weight
            colorMarkings  = existing.colorMarkings
            spayedNeutered = existing.spayedNeutered
            reactive       = existing.reactive
            routine        = existing.routine
            trainingCmds   = existing.trainingCommands
            feedingBrand   = existing.feedingBrand
            vaccinations   = existing.vaccinations
            medsHealth     = existing.medicationHealthNotes
            checklist      = existing.checklist
            staysAs        = existing.staysAs
            officeNotes    = existing.officeNotes
            photoUrl       = existing.profilePictureUrl
            formValues.clear()
            formValues.putAll(existing.formValues)
            initialized = true
        }
    }

    var saving       by remember { mutableStateOf(false) }
    var toast        by remember { mutableStateOf("") }
    var toastVisible by remember { mutableStateOf(false) }
    var toastKind    by remember { mutableStateOf(ToastKind.Info) }
    fun showToast(msg: String, kind: ToastKind = ToastKind.Info) {
        toast = msg; toastKind = kind; toastVisible = true
    }

    fun build(): Kin = (existing ?: Kin(_id = kinId.orEmpty(), kinfolkId = kinfolkId)).copy(
        kinfolkId             = kinfolkId,
        name                  = name.trim(),
        species               = species.trim().ifBlank { "Dog" },
        breed                 = breed.trim(),
        age                   = age.trim(),
        sex                   = sex.trim(),
        weight                = weight.trim(),
        colorMarkings         = colorMarkings.trim(),
        spayedNeutered        = spayedNeutered,
        reactive              = reactive,
        routine               = routine,
        trainingCommands      = trainingCmds,
        feedingBrand          = feedingBrand.trim(),
        vaccinations          = vaccinations,
        medicationHealthNotes = medsHealth,
        checklist             = checklist,
        staysAs               = staysAs.trim(),
        officeNotes           = officeNotes,
        profilePictureUrl     = photoUrl,
        status                = (existing?.status ?: "active"),
        formValues            = formValues.toMap(),
    )

    // item 3: Name + Species + Gender are all required.
    val canSave = name.isNotBlank() && species.isNotBlank() && sex.isNotBlank()
    val c = AuntieTheme.colors

    fun doSave() {
        saving = true
        scope.launch {
            val draft  = build()
            val result = if (isNew) client.createKin(draft) else {
                when (val r = client.updateKin(draft)) {
                    is WriteResult.Ok  -> WriteResult.Ok(draft._id)
                    is WriteResult.Err -> r
                }
            }
            saving = false
            when (result) {
                is WriteResult.Ok  -> {
                    showToast(if (isNew) "Kin added." else "Saved.", ToastKind.Success)
                    onSaved(result.value)
                }
                is WriteResult.Err -> showToast("Save failed: ${result.message}", ToastKind.Error)
            }
        }
    }

    // Refresh intelligence: synthesis is per-HOUSEHOLD, so this re-runs the reconcile pass
    // for the kin's PARENT household (the `kinfolkId` param), not just this one pet. The
    // label/caption say so. In-flight guarded; fail-loud via the screen's showToast.
    var refreshing by remember { mutableStateOf(false) }
    fun doRefresh() {
        if (refreshing) return
        refreshing = true
        scope.launch {
            when (val r = client.synthesizeProfile(kinfolkId)) {
                is WriteResult.Ok  -> showToast(SYNTHESIZE_SUCCESS, ToastKind.Success)
                is WriteResult.Err -> showToast("Refresh failed: ${r.message}", ToastKind.Error)
            }
            refreshing = false
        }
    }

    ScreenScaffold {
        // Den kicker: mono, tracked, uppercase eyebrow above the page title.
        Text(
            text = "THE DEN · KIN PROFILE",
            style = AuntieTheme.typography.mono.copy(letterSpacing = 1.6.sp),
            color = c.primary,
        )
        Spacer(Modifier.height(8.dp))

        // Breadcrumb trail (Directory / Household / kin name), mockup header.
        AuntieBreadcrumbs(
            crumbs = listOf(
                Crumb("Directory"),
                Crumb("Household"),
                Crumb(name.ifBlank { if (isNew) "New kin" else "Kin" }, isCurrent = true),
            ),
            onCrumbClick = { onBack() },
        )
        Spacer(Modifier.height(12.dp))

        // ---- Hero header: avatar + name + back/identity strip ----
        KinHero(
            name     = name,
            species  = species,
            breed    = breed,
            isNew    = isNew,
            reactive = reactive,
            archived = existing?.status == "archived",
            onBack   = onBack,
            photoUrl = photoUrl,
            // Photo upload only once the kin exists (needs a real entityId). Reuses the
            // proven media pipeline; on desktop it fails loud (upload is mobile-only today).
            onChangePhoto = if (!isNew && kinId != null) {
                {
                    scope.launch {
                        when (val r = client.uploadMedia(kinId, "KIN", ByteArray(0), "")) {
                            is WriteResult.Ok -> {
                                val url = r.value.storageUrl
                                photoUrl = url
                                client.updateKin(build().copy(profilePictureUrl = url))
                                showToast("Photo updated.", ToastKind.Success)
                            }
                            is WriteResult.Err -> showToast("Photo upload failed: ${r.message}", ToastKind.Error)
                        }
                    }
                }
            } else null,
        )
        Spacer(Modifier.height(16.dp))

        StatusToast(visible = toastVisible, message = toast, kind = toastKind, onDismiss = { toastVisible = false })

        // ---- Loading: shimmer the panels while the kin stream resolves ----
        if (!isNew && existing == null) {
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                repeat(3) { ShimmerCard(height = 120.dp) }
            }
            return@ScreenScaffold
        }

        // ---- Identity panel ----
        DenPanel(title = "Identity", caption = "who this kin is") {
            // item 3: Name required.
            BottomBorderField(
                name, { name = it }, label = "Name *",
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(14.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                // item 1: Species is a controlled dropdown (was free-text). item 3: required.
                AuntieSelectField(
                    label = "Species *",
                    options = SPECIES_OPTIONS,
                    selected = species.ifBlank { "Dog" },
                    onSelect = { species = it },
                    required = true,
                    modifier = Modifier.weight(1f),
                )
                // Run-4 #6: breed is a type-to-search dropdown over the seeded dog/cat
                // bank; stays free-text so mixes / rare breeds remain enterable. Other
                // species (no bank yet) degrade to a plain field with a disclosed note.
                run {
                    val breedCatalog = breedCatalogForSpecies(species, dogBreeds, catBreeds)
                    val wantsBank = species.equals("Dog", true) || species.equals("Cat", true)
                    BreedField(
                        value = breed,
                        onValueChange = { breed = it },
                        catalog = breedCatalog,
                        note = if (wantsBank && breedCatalog.isEmpty())
                            "Breed list unavailable here, type it in." else null,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
            Spacer(Modifier.height(14.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                BottomBorderField(age,    { age    = it }, label = "Age",    modifier = Modifier.weight(1f))
                // item 3: relabel "Sex" -> "Gender" (model key `sex` kept to avoid a
                // schema migration); controlled dropdown; required.
                AuntieSelectField(
                    label = "Gender *",
                    options = GENDER_OPTIONS,
                    selected = sex.ifBlank { "Unknown" },
                    onSelect = { sex = it },
                    required = true,
                    modifier = Modifier.weight(1f),
                )
                BottomBorderField(weight, { weight = it }, label = "Weight", modifier = Modifier.weight(1f), keyboardType = KeyboardType.Decimal)
            }
            Spacer(Modifier.height(14.dp))
            BottomBorderField(colorMarkings, { colorMarkings = it }, label = "Color & markings", modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                AuntieChip(
                    label    = "Spayed / neutered",
                    selected = spayedNeutered,
                    onClick  = { spayedNeutered = !spayedNeutered },
                    tone     = AuntieChipTone.Teal,
                )
                AuntieChip(
                    label    = "Reactive",
                    selected = reactive,
                    onClick  = { reactive = !reactive },
                    tone     = AuntieChipTone.Orange,
                )
            }
        }
        Spacer(Modifier.height(16.dp))

        // ---- Care panel ----
        DenPanel(title = "Care", caption = "per visit") {
            BottomBorderField(staysAs,      { staysAs      = it }, label = "Stays as (boards / day-care / drop-in)", modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(14.dp))
            BottomBorderField(feedingBrand, { feedingBrand = it }, label = "Feeding brand", modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(14.dp))
            MultilineField(routine,      { routine      = it }, label = "Routine",          minLines = 3, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(14.dp))
            MultilineField(trainingCmds, { trainingCmds = it }, label = "Training commands", minLines = 2, modifier = Modifier.fillMaxWidth())
        }
        Spacer(Modifier.height(16.dp))

        // ---- Health panel (Biscuit-only medical, per the mockup) ----
        DenPanel(title = "Health", caption = "this kin only") {
            MultilineField(medsHealth,   { medsHealth   = it }, label = "Medications & health notes", minLines = 3, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(14.dp))
            MultilineField(vaccinations, { vaccinations = it }, label = "Vaccinations",                minLines = 2, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(14.dp))
            // Vet is read-only here: it is authored once on the owning Kinfolk
            // (household) and inherited. Edit it on the Kinfolk, not per-kin.
            run {
                val household = listOf(parentKinfolk?.firstName, parentKinfolk?.lastName)
                    .mapNotNull { it?.takeIf(String::isNotBlank) }.joinToString(" ").ifBlank { "household" }
                val vetLine = listOf(
                    parentKinfolk?.vetClinicName,
                    parentKinfolk?.vetClinicPhone,
                    parentKinfolk?.vetClinicAddress,
                ).mapNotNull { it?.takeIf(String::isNotBlank) }.joinToString(" · ")
                AuntieFieldLabel(text = "Vet (from $household)")
                Spacer(Modifier.height(4.dp))
                Text(
                    text = vetLine.ifBlank { "No household vet on file yet" },
                    style = AuntieTheme.typography.bodyMedium,
                    color = if (vetLine.isBlank()) c.textDim else c.textPrimary,
                )
            }
        }
        Spacer(Modifier.height(16.dp))

        // ---- Care checklist panel (structured KIN form_schemas, spec 06 item 5) ----
        DenPanel(title = "Care checklist", caption = "per visit") {
            when {
                // Fail loud: a schema load failure is shown, never swallowed.
                schemaError != null -> AuntieBanner(
                    tone = AuntieBannerTone.Error,
                    title = "Couldn't load the care-checklist fields",
                ) {
                    Text(schemaError!!, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                }
                kinSchemas.isNotEmpty() -> DynamicFormFields(
                    schemas = kinSchemas,
                    values = formValues,
                    onValueChange = { k, v -> formValues[k] = v },
                )
                // No KIN schema authored yet: point the operator at where to add one
                // rather than render a silent-empty panel.
                else -> Text(
                    "No KIN care-checklist fields are configured yet. Add them in Format Schemas (applies to = KIN).",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }

            // Legacy free-text checklist preserved READ-ONLY so no historical note is
            // lost when migrating off the blob (spec 06 item 5.3).
            if (checklist.isNotBlank()) {
                Spacer(Modifier.height(16.dp))
                AuntieFieldLabel(text = "Legacy pre-care checklist (read-only)")
                Spacer(Modifier.height(6.dp))
                Text(checklist, style = AuntieTheme.typography.bodySmall, color = c.textDim)
            }
        }
        Spacer(Modifier.height(20.dp))

        // ---- Office panel (admin-only notes) ----
        DenPanel(title = "Office", caption = "admin only") {
            MultilineField(officeNotes, { officeNotes = it }, label = "Auntie's notes", minLines = 3, modifier = Modifier.fillMaxWidth())
        }
        Spacer(Modifier.height(16.dp))

        // ---- Intelligence panel (Refresh intelligence) ----
        // Synthesis runs per household, so this refreshes the whole household, not one pet.
        DenPanel(title = "Intelligence", caption = "whole household") {
            GhostButton(
                label = if (refreshing) "Refreshing…" else "Refresh household intelligence",
                enabled = !refreshing,
                onClick = { doRefresh() },
            )
            Spacer(Modifier.height(6.dp))
            Text(
                "Updates the whole household's dossier and every pet's 411 (not just this pet).",
                style = AuntieTheme.typography.labelSmall,
                color = AuntieTheme.colors.textDim,
            )
        }
        Spacer(Modifier.height(20.dp))

        // ---- Sticky-style save bar (Den editor footer) ----
        AuntieSaveBar(
            dirty       = canSave,
            saveEnabled = canSave && !saving,
            onCancel    = onBack,
            onSave      = { doSave() },
            saveLabel   = if (isNew) "Create Kin" else "Save changes",
            modifier    = Modifier.clip(RoundedCornerShape(16.dp)),
        )

        if (!isNew && existing != null) {
            Spacer(Modifier.height(20.dp))
            ArchiveKinBlock(
                name      = existing.name.ifBlank { "this Kin" },
                archived  = existing.status == "archived",
                disabled  = saving,
                onArchive = {
                    saving = true
                    scope.launch {
                        val r = client.archiveKin(existing._id)
                        saving = false
                        when (r) {
                            is WriteResult.Ok  -> { showToast("Archived ${existing.name}.", ToastKind.Success); onArchived() }
                            is WriteResult.Err -> showToast("Archive failed: ${r.message}", ToastKind.Error)
                        }
                    }
                },
            )
        }
    }
}

/** Avatar + name hero strip, matching the mockup detail header. */
@Composable
private fun KinHero(
    name: String,
    species: String,
    breed: String,
    isNew: Boolean,
    reactive: Boolean,
    archived: Boolean,
    onBack: () -> Unit,
    photoUrl: String? = null,
    onChangePhoto: (() -> Unit)? = null,
) {
    val c = AuntieTheme.colors
    GlassSurface(cornerRadius = 24.dp, modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(20.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            // Real Kin photo when set; otherwise the seeded initial gradient stands in
            // (still on-brand, never an empty hole).
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                AuntieAvatar(
                    imageUrl     = photoUrl?.ifBlank { null },
                    initials     = name.take(1).ifBlank { "?" }.uppercase(),
                    glyph        = if (name.isBlank() && photoUrl.isNullOrBlank()) Lucide.PawPrint else null,
                    size         = 88.dp,
                    gradientSeed = name.ifBlank { "kin" },
                )
                if (onChangePhoto != null) {
                    Text(
                        text = if (photoUrl.isNullOrBlank()) "Add photo" else "Change photo",
                        style = AuntieTheme.typography.labelSmall,
                        color = c.primary,
                        modifier = Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .clickable(onClick = onChangePhoto)
                            .padding(horizontal = 8.dp, vertical = 4.dp),
                    )
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.weight(1f)) {
                Text(
                    text  = name.ifBlank { if (isNew) "New kin" else "Kin" },
                    style = AuntieTheme.typography.headlineLarge,
                    color = c.textPrimary,
                )
                val subtitle = listOf(breed, species).filter { it.isNotBlank() }.joinToString(" · ")
                if (subtitle.isNotBlank()) {
                    Text(subtitle, style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                }
                Row(
                    modifier = Modifier.padding(top = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (reactive) {
                        AuntieStatusPill(label = "Reactive", tone = AuntieStatusTone.Orange, mono = true)
                    }
                    if (archived) {
                        AuntieStatusPill(label = "Archived", tone = AuntieStatusTone.Muted, mono = true)
                    }
                }
            }
            GhostButton(label = "Back", onClick = onBack)
        }
    }
}

/**
 * Den section panel: a glass surface with a Fraunces-style title + mono caption,
 * matching the mockup's left/right ".panel h3" cards.
 */
@Composable
private fun DenPanel(
    title: String,
    caption: String,
    content: @Composable () -> Unit,
) {
    val c = AuntieTheme.colors
    GlassSurface(cornerRadius = 20.dp, modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.fillMaxWidth().padding(20.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(bottom = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(title, style = AuntieTheme.typography.titleLarge, color = c.textPrimary)
                Text(
                    text  = caption.uppercase(),
                    style = AuntieTheme.typography.mono.copy(fontSize = 11.sp, letterSpacing = 0.6.sp),
                    color = c.textDim,
                )
            }
            content()
        }
    }
}

@Composable
private fun ArchiveKinBlock(
    name: String,
    archived: Boolean,
    disabled: Boolean,
    onArchive: () -> Unit,
) {
    val c = AuntieTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(c.surfaceGlass, shape = RoundedCornerShape(10.dp))
            .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(10.dp))
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        AuntieFieldLabel(text = if (archived) "Archived" else "Danger zone")
        Text(
            text  = if (archived) "Already archived" else "Archive this Kin",
            style = AuntieTheme.typography.titleMedium,
            color = c.textPrimary,
        )
        Text(
            text  = if (archived) "$name is archived. They no longer show in their household's active Kin list."
                    else            "Archiving keeps history but hides $name from the household's active Kin list. Reversible.",
            style = AuntieTheme.typography.bodySmall,
            color = c.textDim,
        )
        if (!archived) {
            GhostButton(label = "Archive", onClick = onArchive, enabled = !disabled, modifier = Modifier.fillMaxWidth())
        }
    }
}

// ---- Run-4 #6: breed dropdown (pure helpers + field) ----

/**
 * Pure filter for the breed search box. Prefix matches rank first, then substring,
 * capped at [limit] so a 478-dog / 103-cat bank stays a short, scannable dropdown.
 * A blank query returns nothing (search field, not a full-catalog dump). Mirrors
 * vetClinicSuggestions; android carries a twin.
 */
internal fun breedSuggestions(query: String, breeds: List<String>, limit: Int = 8): List<String> {
    val q = query.trim().lowercase()
    if (q.isEmpty()) return emptyList()
    val starts = breeds.filter { it.lowercase().startsWith(q) }
    val contains = breeds.filter { !it.lowercase().startsWith(q) && it.lowercase().contains(q) }
    return (starts + contains).take(limit)
}

/**
 * B5: what the breed dropdown shows. Blank input returns the catalog head so the
 * seeded bank is visible the moment the field opens (the old field showed nothing
 * until you typed, which read as "breed not pulling the DB"); a typed query filters
 * via [breedSuggestions]. Empty catalog → empty (non-Dog/Cat species, free-text).
 */
internal fun breedDropdownOptions(query: String, catalog: List<String>, limit: Int = 12): List<String> {
    val q = query.trim()
    return if (q.isEmpty()) catalog.take(limit) else breedSuggestions(q, catalog, limit)
}

/**
 * Which seeded breed bank applies to a species. Dog and Cat have curated banks;
 * every other species keeps free-text until its bank is seeded, signaled by an
 * empty list. Case-insensitive on the species string.
 */
internal fun breedCatalogForSpecies(
    species: String,
    dogBreeds: List<String>,
    catBreeds: List<String>,
): List<String> = when (species.trim().lowercase()) {
    "dog" -> dogBreeds
    "cat" -> catBreeds
    else  -> emptyList()
}

/**
 * Breed input. When a seeded bank exists for the species it is a type-to-search
 * dropdown over that bank; the value stays free-text so a breed not in the bank (mix,
 * rare) is still enterable. An empty bank (other species, or the desktop callable
 * stub) degrades to a plain field, with [note] disclosing the degraded state.
 */
@Composable
private fun BreedField(
    value: String,
    onValueChange: (String) -> Unit,
    catalog: List<String>,
    note: String?,
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    val options = breedDropdownOptions(value, catalog)
    val exact = catalog.any { it.equals(value.trim(), ignoreCase = true) }
    Column(modifier) {
        BottomBorderField(
            value = value,
            onValueChange = onValueChange,
            label = "Breed",
            placeholder = if (catalog.isEmpty()) "" else "Type to search, or pick from the list",
            modifier = Modifier.fillMaxWidth(),
        )
        if (note != null) {
            Spacer(Modifier.height(4.dp))
            Text(note, style = AuntieTheme.typography.bodySmall, color = c.textDim)
        }
        // B5: show the seeded bank immediately — the catalog head when blank, filtered
        // as the operator types — so breeds are visible without typing. The old field
        // showed nothing until a keystroke, which read as "breed not pulling the DB".
        // Collapses once an exact breed is chosen.
        if (options.isNotEmpty() && !exact) {
            Spacer(Modifier.height(8.dp))
            if (value.isBlank() && catalog.size > options.size) {
                Text(
                    "Showing ${options.size} of ${catalog.size}, type to filter",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
                Spacer(Modifier.height(6.dp))
            }
            GlassSurface(cornerRadius = 14.dp, modifier = Modifier.fillMaxWidth()) {
                Column(
                    Modifier.fillMaxWidth()
                        .heightIn(max = 240.dp)
                        .verticalScroll(rememberScrollState()),
                ) {
                    options.forEach { breed ->
                        Text(
                            text = breed,
                            style = AuntieTheme.typography.bodyMedium,
                            color = c.textPrimary,
                            modifier = Modifier.fillMaxWidth()
                                .clickable { onValueChange(breed) }
                                .padding(horizontal = 16.dp, vertical = 10.dp),
                        )
                    }
                }
            }
        }
    }
}
