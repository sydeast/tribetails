package com.kinfolk.portal.screens.kin

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BrokenImage
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import coil3.compose.SubcomposeAsyncImage
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinField
import com.kinfolk.portal.components.KinGhostButton
import com.kinfolk.portal.components.KinfolkRemoteImage
import com.kinfolk.portal.components.SchemaFormRenderer
import com.kinfolk.portal.media.KinPhotoPolicy
import com.kinfolk.portal.media.PickedImage
import com.kinfolk.portal.media.rememberPhotoPicker
import com.kinfolk.portal.portal.FormSchema
import com.kinfolk.portal.portal.Kin
import com.kinfolk.portal.portal.KinPayload
import com.kinfolk.portal.portal.KinStatus
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import kotlinx.coroutines.launch

@Composable
fun AddEditKinDialog(
    initial: Kin?,
    onClose: () -> Unit,
    onSubmit: suspend (KinPayload, KinPhotoChange) -> String?,
    schema: FormSchema? = null,
    dogBreeds: List<String> = emptyList(),
    catBreeds: List<String> = emptyList(),
    /** #1291. True while the controller's photo upload runs, for the Save label. */
    photoUploading: Boolean = false,
    /**
     * #1311. Edit only: marks the Kin no longer with us (`restore` false) or
     * restores it (true). Returns null on success, else an inline message.
     * Null (the Add dialog) hides the action.
     */
    onArchive: (suspend (restore: Boolean) -> String?)? = null,
) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()
    var saving by remember { mutableStateOf(false) }
    var submitError by remember { mutableStateOf<String?>(null) }
    // #1311 memorial action state. `archiving` locks Save and dismiss the way
    // `saving` locks the action, so only one write is ever in flight.
    var confirmingArchive by remember { mutableStateOf(false) }
    var archiving by remember { mutableStateOf(false) }
    var archiveError by remember { mutableStateOf<String?>(null) }
    val busy = saving || archiving
    var name by remember { mutableStateOf(initial?.name.orEmpty()) }
    var species by remember { mutableStateOf(initial?.species.orEmpty()) }
    var breed by remember { mutableStateOf(initial?.breed.orEmpty()) }
    var ageText by remember { mutableStateOf(ageSeedText(initial?.ageYears)) }
    var feed by remember { mutableStateOf(initial?.feedingInstructions.orEmpty()) }
    var walk by remember { mutableStateOf(initial?.walkingInstructions.orEmpty()) }
    var meds by remember { mutableStateOf(initial?.medications.orEmpty()) }
    var allergies by remember { mutableStateOf(initial?.allergies.orEmpty()) }
    var emergency by remember { mutableStateOf(initial?.emergencyNotes.orEmpty()) }
    var sitter by remember { mutableStateOf(initial?.sitterNotes.orEmpty()) }
    var sex by remember { mutableStateOf(initial?.sex.orEmpty()) }
    var weight by remember { mutableStateOf(initial?.weight.orEmpty()) }
    var markings by remember { mutableStateOf(initial?.colorMarkings.orEmpty()) }
    var fixed by remember { mutableStateOf(initial?.spayedNeutered ?: false) }
    var vet by remember { mutableStateOf(initial?.vetInfo.orEmpty()) }

    // Photo: picked locally, uploaded by the controller after the kin write
    // succeeds (add needs the new kinId before the Storage path exists).
    var pickedPhoto by remember { mutableStateOf<PickedImage?>(null) }
    // #1291: Remove marks the saved photo for clearing on Save (edit only).
    var removePhoto by remember { mutableStateOf(false) }
    var photoError by remember { mutableStateOf<String?>(null) }
    val launchPhotoPicker = rememberPhotoPicker { picked ->
        if (picked == null) return@rememberPhotoPicker // cancelled — keep current state
        val problem = KinPhotoPolicy.validate(picked)
        if (problem != null) {
            photoError = problem
        } else {
            photoError = null
            pickedPhoto = picked
            removePhoto = false
        }
    }
    val savedPhotoUrl = initial?.photoUrl.orEmpty()

    // Schema-driven edit values, seeded from the existing Kin. Name stays a
    // dedicated control above the schema since the payload requires it.
    var kinValues by remember {
        mutableStateOf(
            mapOf(
                "species" to species,
                "breed" to breed,
                "ageYears" to ageText,
                "feedingInstructions" to feed,
                "walkingInstructions" to walk,
                "medications" to meds,
                "allergies" to allergies,
                "emergencyNotes" to emergency,
                "sitterNotes" to sitter,
            )
        )
    }

    AlertDialog(
        onDismissRequest = { if (!busy) onClose() },
        containerColor = KinfolkBrand.Cream,
        shape = KinfolkShapes.card,
        title = { Text(if (initial == null) "Add Kin" else "Edit ${initial.name ?: "Kin"}", style = type.heritageTitle) },
        text = {
            Column(
                modifier = Modifier.verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
            ) {
                KinField(value = name, onValueChange = { name = it }, label = "Name")

                // -- Photo --
                Text("PHOTO", style = type.sansMeta)
                Row(
                    horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val previewShape = RoundedCornerShape(12.dp)
                    val picked = pickedPhoto
                    if (picked != null) {
                        Box(
                            modifier = Modifier
                                .size(72.dp)
                                .clip(previewShape)
                                .background(KinfolkBrand.GlassSurface),
                            contentAlignment = Alignment.Center,
                        ) {
                            // A freshly-picked file rarely fails to decode, but "rarely"
                            // is not "never" (a corrupt file, a format Coil can't read),
                            // and a plain AsyncImage with no error slot renders an empty
                            // box on that failure -- Compose has no OS-level broken-image
                            // glyph the way a browser <img> does. SubcomposeAsyncImage's
                            // error slot is the same pattern RemoteImage.kt already
                            // established for every other portal photo surface (S9).
                            SubcomposeAsyncImage(
                                model = picked.bytes,
                                contentDescription = "New photo for ${name.ifBlank { "this Kin" }}",
                                modifier = Modifier.fillMaxSize(),
                                contentScale = ContentScale.Crop,
                                error = {
                                    Icon(
                                        imageVector = Icons.Filled.BrokenImage,
                                        contentDescription = "New photo for ${name.ifBlank { "this Kin" }}",
                                        tint = KinfolkBrand.NavyMuted,
                                    )
                                },
                            )
                        }
                    } else {
                        KinfolkRemoteImage(
                            url = if (removePhoto) "" else savedPhotoUrl,
                            contentDescription = "Current photo",
                            modifier = Modifier.size(72.dp),
                        )
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
                        KinGhostButton(
                            label = when {
                                pickedPhoto != null -> "Change Photo"
                                savedPhotoUrl.isNotBlank() && !removePhoto -> "Replace Photo"
                                else -> "Add Photo"
                            },
                            onClick = { if (!saving) launchPhotoPicker() },
                        )
                        if (pickedPhoto != null || (savedPhotoUrl.isNotBlank() && !removePhoto)) {
                            KinGhostButton(
                                label = "Remove Photo",
                                onClick = {
                                    if (!saving) {
                                        if (pickedPhoto != null) {
                                            pickedPhoto = null
                                        } else {
                                            removePhoto = true
                                        }
                                        photoError = null
                                    }
                                },
                            )
                        }
                        if (removePhoto && pickedPhoto == null) {
                            Text(text = "Photo will be removed when you save", style = type.sansMeta)
                        }
                        val picked2 = pickedPhoto
                        if (picked2 != null) {
                            Text(
                                text = "${picked2.fileName.ifBlank { "photo" }} (uploads when you save)",
                                style = type.sansMeta,
                            )
                        }
                    }
                }
                photoError?.let { problem ->
                    Text(text = problem, style = type.sansMeta.copy(color = KinfolkBrand.SnuggleCoral))
                }

                if (schema != null) {
                    // Admin schema drives the profile + care fields.
                    SchemaFormRenderer(
                        schema = schema,
                        values = kinValues,
                        onChange = { kinValues = it },
                    )
                } else {
                    SpeciesRadioGroup(
                        selected = species,
                        onSelect = { next ->
                            // Typing in the Other box edits the same species; only a
                            // change of picker entry resets the breed.
                            if (!next.equals(species, ignoreCase = true) && speciesChoice(next) != SPECIES_OTHER) breed = ""
                            species = next
                        },
                    )
                    BreedField(
                        species = species,
                        breed = breed,
                        onBreedChange = { breed = it },
                        dogBreeds = dogBreeds,
                        catBreeds = catBreeds,
                    )
                    KinField(value = ageText, onValueChange = { ageText = it.filter { c -> c.isDigit() } }, label = "Age (years)")
                    KinField(value = feed, onValueChange = { feed = it }, label = "Feeding Instructions", singleLine = false)
                    KinField(value = walk, onValueChange = { walk = it }, label = "Walking Instructions", singleLine = false)
                    KinField(value = meds, onValueChange = { meds = it }, label = "Medications", singleLine = false)
                    KinField(value = allergies, onValueChange = { allergies = it }, label = "Allergies", singleLine = false)
                    KinField(value = emergency, onValueChange = { emergency = it }, label = "Emergency Notes", singleLine = false)
                    KinField(value = sitter, onValueChange = { sitter = it }, label = "Sitter Notes", singleLine = false)
                }
                // The facts shared with the admin (#1310). Outside the schema branch so a
                // schema-driven form still carries them.
                SexRadioGroup(selected = sex, onSelect = { sex = it })
                KinField(value = weight, onValueChange = { weight = it }, label = "Weight")
                KinField(value = markings, onValueChange = { markings = it }, label = "Color / markings")
                Row(
                    modifier = Modifier.fillMaxWidth().clickable { fixed = !fixed },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Checkbox(
                        checked = fixed,
                        onCheckedChange = { fixed = it },
                        colors = CheckboxDefaults.colors(checkedColor = KinfolkBrand.KinfolkOrange),
                    )
                    Text("Spayed / neutered", style = type.sansBody)
                }
                KinField(value = vet, onValueChange = { vet = it }, label = "Vet", singleLine = false)
                submitError?.let { problem ->
                    Text(text = problem, style = type.sansMeta.copy(color = KinfolkBrand.SnuggleCoral))
                }

                // #1311: the memorial action, edit only, last in the form behind a
                // hairline. One row today; #1314 and #1408 add theirs below it.
                // AlertDialog draws Save / Cancel in its own chrome under this
                // column, so "last control" here means last in the body.
                if (initial != null && onArchive != null) {
                    Box(Modifier.fillMaxWidth().height(1.dp).background(KinfolkBrand.NavyHairline))
                    MemorialAction(
                        kinName = initial.name,
                        memorial = initial.status == KinStatus.NoLongerWithUs,
                        busy = archiving,
                        enabled = !busy,
                        error = archiveError,
                        confirming = confirmingArchive,
                        onConfirmingChange = { confirmingArchive = it },
                        onArchive = { restore ->
                            scope.launch {
                                archiving = true
                                archiveError = null
                                val err = onArchive(restore)
                                archiving = false
                                if (err == null) onClose() else archiveError = err
                            }
                        },
                    )
                }
            }
        },
        confirmButton = {
            val submit = {
                    // Typed save: read schema values when the schema drives the form,
                    // otherwise the static field state. #1336: both are diffed against
                    // the loaded Kin (kinCareFieldsPayload). A key the schema map lacks
                    // falls back to the static field, which still holds the seed.
                    val payload = if (schema != null) {
                        kinCareFieldsPayload(
                            initial = initial,
                            name = name,
                            species = kinValues["species"] ?: species,
                            breed = kinValues["breed"] ?: breed,
                            ageText = kinValues["ageYears"] ?: ageText,
                            feed = kinValues["feedingInstructions"] ?: feed,
                            walk = kinValues["walkingInstructions"] ?: walk,
                            meds = kinValues["medications"] ?: meds,
                            allergies = kinValues["allergies"] ?: allergies,
                            emergency = kinValues["emergencyNotes"] ?: emergency,
                            sitter = kinValues["sitterNotes"] ?: sitter,
                        )
                    } else {
                        kinCareFieldsPayload(
                            initial = initial,
                            name = name,
                            species = species,
                            breed = breed,
                            ageText = ageText,
                            feed = feed,
                            walk = walk,
                            meds = meds,
                            allergies = allergies,
                            emergency = emergency,
                            sitter = sitter,
                        )
                    }
                    val facts = sharedFactsPayload(
                        initial = initial,
                        sex = sex,
                        weight = weight,
                        markings = markings,
                        fixed = fixed,
                        vet = vet,
                    )
                    val finalPayload = payload.copy(
                        sex = facts.sex,
                        weight = facts.weight,
                        colorMarkings = facts.colorMarkings,
                        spayedNeutered = facts.spayedNeutered,
                        vetInfo = facts.vetInfo,
                    )
                    scope.launch {
                        saving = true
                        submitError = null
                        val err = onSubmit(finalPayload, KinPhotoChange.of(pickedPhoto, removePhoto))
                        saving = false
                        if (err == null) onClose() else submitError = err
                    }
                    Unit
            }
            KinButton(
                label = when {
                    saving && photoUploading -> "Uploading photo…"
                    saving -> "Saving…"
                    initial == null -> "Add Kin"
                    else -> "Save"
                },
                onClick = submit,
                enabled = name.isNotBlank() && !busy,
            )
        },
        dismissButton = { TextButton(onClick = { if (!busy) onClose() }) { Text("Cancel") } },
    )
}

/**
 * #1311. Mark / restore control at the foot of the edit form. An active Kin
 * gets "Mark No Longer With Us" behind a confirm step; a memorial Kin gets
 * "Restore as Active" one tap, in the same slot. Purple solid / coral outline
 * match the web KinEdit buttons.
 */
@Composable
private fun MemorialAction(
    kinName: String?,
    memorial: Boolean,
    busy: Boolean,
    enabled: Boolean,
    error: String?,
    confirming: Boolean,
    onConfirmingChange: (Boolean) -> Unit,
    onArchive: (restore: Boolean) -> Unit,
) {
    val type = LocalKinfolkTypography.current
    Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
        when {
            memorial -> OutlinePillButton(
                label = if (busy) "Restoring…" else "Restore as Active",
                color = KinfolkBrand.SnuggleCoral,
                onClick = { if (enabled) onArchive(true) },
                modifier = Modifier.fillMaxWidth(),
            )
            confirming -> {
                Text(
                    "Mark ${kinName ?: "this Kin"} as no longer with us? You can restore the profile from here.",
                    style = type.sansMeta,
                )
                SolidPillButton(
                    label = if (busy) "Saving…" else "Yes, mark No Longer With Us",
                    color = KinfolkBrand.FamilyPurple,
                    onClick = { if (enabled) onArchive(false) },
                    modifier = Modifier.fillMaxWidth(),
                )
                KinGhostButton(
                    label = "Never mind",
                    onClick = { onConfirmingChange(false) },
                    enabled = enabled,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            else -> SolidPillButton(
                label = "Mark No Longer With Us",
                color = KinfolkBrand.FamilyPurple,
                onClick = { if (enabled) onConfirmingChange(true) },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        error?.let { problem ->
            Text(text = problem, style = type.sansMeta.copy(color = KinfolkBrand.SnuggleCoral))
        }
    }
}

// ---- Small brand buttons (purple solid / coral outline, per the kin-detail mockup) ----

@Composable
private fun SolidPillButton(label: String, color: Color, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val type = LocalKinfolkTypography.current
    Box(
        modifier = modifier
            .clip(KinfolkShapes.pill)
            .background(color)
            .clickable { onClick() }
            .padding(horizontal = KinfolkSpacing.l, vertical = 13.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = type.sansButton)
    }
}

@Composable
private fun OutlinePillButton(label: String, color: Color, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val type = LocalKinfolkTypography.current
    Box(
        modifier = modifier
            .clip(KinfolkShapes.pill)
            .border(1.dp, color.copy(alpha = 0.5f), KinfolkShapes.pill)
            .clickable { onClick() }
            .padding(horizontal = KinfolkSpacing.l, vertical = 13.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = type.sansButton.copy(color = color))
    }
}

private val SEX_OPTIONS = listOf("Male", "Female", "Unknown")

/** The age the dialog shows for a stored age (whole years), and diffs against. */
internal fun ageSeedText(ageYears: Double?): String = ageYears?.toInt()?.toString().orEmpty()

/**
 * #1336. The name and the parent-owned fields, diffed against what the dialog
 * seeded from [initial]: an untouched field is left null (not sent), a changed
 * one carries its trimmed value, and one the household emptied is named in
 * [KinPayload.clearFields] so it goes as JSON `null` and clears on the server.
 * Before this every field was rebuilt from form state and a blank became a
 * null that was never sent, so a cleared medication came back on reload.
 *
 * [initial] null (Add) diffs against blanks: only filled fields are sent.
 * An age that does not parse is left alone rather than cleared. The name is
 * always sent (the payload requires it).
 */
internal fun kinCareFieldsPayload(
    initial: com.kinfolk.portal.portal.Kin?,
    name: String,
    species: String,
    breed: String,
    ageText: String,
    feed: String,
    walk: String,
    meds: String,
    allergies: String,
    emergency: String,
    sitter: String,
): KinPayload {
    val clears = mutableSetOf<String>()
    fun text(key: String, now: String, before: String?): String? {
        val next = now.trim()
        if (next == before.orEmpty().trim()) return null
        if (next.isEmpty()) {
            clears += key
            return null
        }
        return next
    }
    val ageNow = ageText.trim()
    val ageYears: Double? = when {
        ageNow == ageSeedText(initial?.ageYears) -> null
        ageNow.isEmpty() -> { clears += "ageYears"; null }
        else -> ageNow.toDoubleOrNull()
    }
    return KinPayload(
        name = name.trim(),
        species = text("species", species, initial?.species),
        breed = text("breed", breed, initial?.breed),
        ageYears = ageYears,
        feedingInstructions = text("feedingInstructions", feed, initial?.feedingInstructions),
        walkingInstructions = text("walkingInstructions", walk, initial?.walkingInstructions),
        medications = text("medications", meds, initial?.medications),
        allergies = text("allergies", allergies, initial?.allergies),
        emergencyNotes = text("emergencyNotes", emergency, initial?.emergencyNotes),
        sitterNotes = text("sitterNotes", sitter, initial?.sitterNotes),
        legacyKinId = initial?.id?.takeIf { it.matches(Regex("\\d+")) },
        clearFields = clears,
    )
}

/** What the dialog sends for the five shared facts: null = leave alone, "" = clear. */
internal data class SharedFacts(
    val sex: String?,
    val weight: String?,
    val colorMarkings: String?,
    val spayedNeutered: Boolean?,
    val vetInfo: String?,
)

/**
 * Diff each shared fact against what the kin carried. An untouched field sends
 * null, so a save never rewrites a value this form did not change; a field the
 * household emptied sends "" to clear it. [initial] null (Add) sends only what
 * was filled in.
 */
internal fun sharedFactsPayload(
    initial: com.kinfolk.portal.portal.Kin?,
    sex: String,
    weight: String,
    markings: String,
    fixed: Boolean,
    vet: String,
): SharedFacts {
    fun text(now: String, before: String?): String? {
        val next = now.trim()
        val prev = before.orEmpty().trim()
        return if (next == prev) null else next
    }
    return SharedFacts(
        sex = text(sex, initial?.sex),
        weight = text(weight, initial?.weight),
        colorMarkings = text(markings, initial?.colorMarkings),
        spayedNeutered = if (fixed == (initial?.spayedNeutered ?: false)) null else fixed,
        vetInfo = text(vet, initial?.vetInfo),
    )
}

@Composable
private fun SexRadioGroup(selected: String, onSelect: (String) -> Unit) {
    val type = LocalKinfolkTypography.current
    // A value the admin wrote outside the three ("F") stays selectable.
    val options = if (selected.isNotBlank() && SEX_OPTIONS.none { it == selected }) SEX_OPTIONS + selected else SEX_OPTIONS
    Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
        Text("SEX", style = type.sansMeta)
        Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            options.forEach { opt ->
                Row(
                    modifier = Modifier.clickable { onSelect(opt) },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(
                        selected = selected == opt,
                        onClick = { onSelect(opt) },
                        colors = RadioButtonDefaults.colors(selectedColor = KinfolkBrand.KinfolkOrange),
                    )
                    Text(opt, style = type.sansBody)
                }
            }
        }
    }
}

/** Species the breed banks support today. Dog/Cat get a searchable breed list;
 *  the rest keep a free-text breed until their banks are seeded. */
private val SPECIES_OPTIONS = listOf("Dog", "Cat", "Rabbit", "Small Animal", "Reptile", "Fish", "Bird", "Turtle")
/** The picker entry for a stored species: "Other" is a picker entry, never a stored value. */
internal const val SPECIES_OTHER = "Other"
/**
 * Which radio a stored species belongs to: a listed species (any case), else
 * [SPECIES_OTHER] when something non-blank is stored (a legacy "Ferret" keeps its
 * text), else null when unset.
 */
internal fun speciesChoice(species: String): String? {
    val trimmed = species.trim()
    if (trimmed.isEmpty()) return null
    return SPECIES_OPTIONS.firstOrNull { it.equals(trimmed, ignoreCase = true) } ?: SPECIES_OTHER
}

@Composable
private fun SpeciesRadioGroup(selected: String, onSelect: (String) -> Unit) {
    val type = LocalKinfolkTypography.current
    var otherPicked by remember { mutableStateOf(speciesChoice(selected) == SPECIES_OTHER) }
    val choice = if (otherPicked) SPECIES_OTHER else speciesChoice(selected)
    Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
        Text("SPECIES", style = type.sansMeta)
        (SPECIES_OPTIONS + SPECIES_OTHER).chunked(2).forEach { rowOpts ->
            Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                rowOpts.forEach { opt ->
                    val pick = {
                        if (opt == SPECIES_OTHER) {
                            otherPicked = true
                            // Keep an already-custom species; clear a listed one.
                            if (speciesChoice(selected) != SPECIES_OTHER) onSelect("")
                        } else {
                            otherPicked = false
                            onSelect(opt)
                        }
                    }
                    Row(
                        modifier = Modifier.weight(1f).clickable { pick() },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(
                            selected = choice == opt,
                            onClick = { pick() },
                            colors = RadioButtonDefaults.colors(selectedColor = KinfolkBrand.KinfolkOrange),
                        )
                        Text(opt, style = type.sansBody)
                    }
                }
            }
        }
        if (otherPicked) {
            KinField(value = selected, onValueChange = { onSelect(it) }, label = "Other species")
        }
    }
}
/** Breed input: a type-to-search list for Dog/Cat (478/103 seeded breeds),
 *  a plain text field for every other species (and before the lists load). */
@Composable
private fun BreedField(
    species: String,
    breed: String,
    onBreedChange: (String) -> Unit,
    dogBreeds: List<String>,
    catBreeds: List<String>,
) {
    val type = LocalKinfolkTypography.current
    val options = when {
        species.equals("Dog", ignoreCase = true) -> dogBreeds
        species.equals("Cat", ignoreCase = true) -> catBreeds
        else -> emptyList()
    }
    if (options.isEmpty()) {
        KinField(value = breed, onValueChange = onBreedChange, label = "Breed")
    } else {
        val matches = remember(breed, options) {
            if (breed.isBlank()) emptyList()
            else options.filter { it.contains(breed, ignoreCase = true) && !it.equals(breed, ignoreCase = true) }.take(8)
        }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            KinField(value = breed, onValueChange = onBreedChange, label = "Breed (type to search)")
            matches.forEach { opt ->
                Text(
                    text = opt,
                    style = type.sansBody.copy(color = KinfolkBrand.KinTeal),
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onBreedChange(opt) }
                        .padding(vertical = 6.dp, horizontal = 4.dp),
                )
            }
        }
    }
}
