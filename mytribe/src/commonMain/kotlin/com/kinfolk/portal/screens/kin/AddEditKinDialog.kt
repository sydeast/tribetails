package com.kinfolk.portal.screens.kin

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.BrokenImage
import androidx.compose.material3.AlertDialog
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
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import kotlinx.coroutines.launch

@Composable
fun AddEditKinDialog(
    initial: Kin?,
    onClose: () -> Unit,
    onSubmit: suspend (KinPayload, PickedImage?) -> String?,
    schema: FormSchema? = null,
    dogBreeds: List<String> = emptyList(),
    catBreeds: List<String> = emptyList(),
) {
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()
    var saving by remember { mutableStateOf(false) }
    var submitError by remember { mutableStateOf<String?>(null) }
    var name by remember { mutableStateOf(initial?.name.orEmpty()) }
    var species by remember { mutableStateOf(initial?.species.orEmpty()) }
    var breed by remember { mutableStateOf(initial?.breed.orEmpty()) }
    var ageText by remember { mutableStateOf(initial?.ageYears?.toInt()?.toString().orEmpty()) }
    var feed by remember { mutableStateOf(initial?.feedingInstructions.orEmpty()) }
    var walk by remember { mutableStateOf(initial?.walkingInstructions.orEmpty()) }
    var meds by remember { mutableStateOf(initial?.medications.orEmpty()) }
    var allergies by remember { mutableStateOf(initial?.allergies.orEmpty()) }
    var emergency by remember { mutableStateOf(initial?.emergencyNotes.orEmpty()) }
    var sitter by remember { mutableStateOf(initial?.sitterNotes.orEmpty()) }

    // Photo: picked locally, uploaded by the controller after the kin write
    // succeeds (add needs the new kinId before the Storage path exists).
    var pickedPhoto by remember { mutableStateOf<PickedImage?>(null) }
    var photoError by remember { mutableStateOf<String?>(null) }
    val launchPhotoPicker = rememberPhotoPicker { picked ->
        if (picked == null) return@rememberPhotoPicker // cancelled — keep current state
        val problem = KinPhotoPolicy.validate(picked)
        if (problem != null) {
            photoError = problem
        } else {
            photoError = null
            pickedPhoto = picked
        }
    }

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
        onDismissRequest = { if (!saving) onClose() },
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
                            url = initial?.photoUrl.orEmpty(),
                            contentDescription = "Current photo",
                            modifier = Modifier.size(72.dp),
                        )
                    }
                    Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
                        KinGhostButton(
                            label = when {
                                pickedPhoto != null -> "Change Photo"
                                !initial?.photoUrl.isNullOrBlank() -> "Replace Photo"
                                else -> "Add Photo"
                            },
                            onClick = launchPhotoPicker,
                        )
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
                        onSelect = { species = it; breed = "" },
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
                submitError?.let { problem ->
                    Text(text = problem, style = type.sansMeta.copy(color = KinfolkBrand.SnuggleCoral))
                }
            }
        },
        confirmButton = {
            val submit = {
                    // Typed save: read schema values when the schema drives the form,
                    // otherwise the static field state. Maps onto the same KinPayload.
                    val payload = if (schema != null) {
                        KinPayload(
                            name = name.trim(),
                            species = kinValues["species"].orEmpty().trim().ifBlank { null },
                            breed = kinValues["breed"].orEmpty().trim().ifBlank { null },
                            ageYears = kinValues["ageYears"].orEmpty().toDoubleOrNull(),
                            feedingInstructions = kinValues["feedingInstructions"].orEmpty().trim().ifBlank { null },
                            walkingInstructions = kinValues["walkingInstructions"].orEmpty().trim().ifBlank { null },
                            medications = kinValues["medications"].orEmpty().trim().ifBlank { null },
                            allergies = kinValues["allergies"].orEmpty().trim().ifBlank { null },
                            emergencyNotes = kinValues["emergencyNotes"].orEmpty().trim().ifBlank { null },
                            sitterNotes = kinValues["sitterNotes"].orEmpty().trim().ifBlank { null },
                            legacyKinId = initial?.id?.takeIf { it.matches(Regex("\\d+")) },
                        )
                    } else {
                        KinPayload(
                            name = name.trim(),
                            species = species.trim().ifBlank { null },
                            breed = breed.trim().ifBlank { null },
                            ageYears = ageText.toIntOrNull()?.toDouble(),
                            feedingInstructions = feed.trim().ifBlank { null },
                            walkingInstructions = walk.trim().ifBlank { null },
                            medications = meds.trim().ifBlank { null },
                            allergies = allergies.trim().ifBlank { null },
                            emergencyNotes = emergency.trim().ifBlank { null },
                            sitterNotes = sitter.trim().ifBlank { null },
                            legacyKinId = initial?.id?.takeIf { it.matches(Regex("\\d+")) },
                        )
                    }
                    scope.launch {
                        saving = true
                        submitError = null
                        val err = onSubmit(payload, pickedPhoto)
                        saving = false
                        if (err == null) onClose() else submitError = err
                    }
                    Unit
            }
            KinButton(
                label = if (saving) "Saving…" else if (initial == null) "Add Kin" else "Save",
                onClick = submit,
                enabled = name.isNotBlank() && !saving,
            )
        },
        dismissButton = { TextButton(onClick = { if (!saving) onClose() }) { Text("Cancel") } },
    )
}

/** Species the breed banks support today. Dog/Cat get a searchable breed list;
 *  the rest keep a free-text breed until their banks are seeded. */
private val SPECIES_OPTIONS = listOf("Dog", "Cat", "Small Animal", "Reptile", "Fish", "Bird", "Turtle")

@Composable
private fun SpeciesRadioGroup(selected: String, onSelect: (String) -> Unit) {
    val type = LocalKinfolkTypography.current
    Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
        Text("SPECIES", style = type.sansMeta)
        SPECIES_OPTIONS.chunked(2).forEach { rowOpts ->
            Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                rowOpts.forEach { opt ->
                    Row(
                        modifier = Modifier.weight(1f).clickable { onSelect(opt) },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(
                            selected = selected.equals(opt, ignoreCase = true),
                            onClick = { onSelect(opt) },
                            colors = RadioButtonDefaults.colors(selectedColor = KinfolkBrand.KinfolkOrange),
                        )
                        Text(opt, style = type.sansBody)
                    }
                }
            }
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
