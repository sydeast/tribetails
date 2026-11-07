package com.tribetails.auntieos.web.screens.media

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import com.tribetails.auntieos.web.observability.rememberReportingScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.SnapshotStateList
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.FileText
import com.composables.icons.lucide.Images
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Music
import com.composables.icons.lucide.Play
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Kin
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.data.MediaFile
import com.tribetails.auntieos.web.data.WriteResult
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieMediaCell
import com.tribetails.auntieos.web.ui.components.DenScreenHeading
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.GlassSurface
import com.tribetails.auntieos.web.ui.components.MediaCellGlyphs
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.ReadStatusBanner
import com.tribetails.auntieos.web.ui.components.StatusToast
import com.tribetails.auntieos.web.ui.components.ToastKind
import com.tribetails.auntieos.web.ui.components.rememberLiveRead
import kotlinx.coroutines.launch

/**
 * #13 global Gallery: every piece of business media across all KinTales/entities in
 * one place, each carrying its kinfolk (household) + entity association. Filter by
 * household, type, and month; tap a tile to tag the specific kin shown in it
 * (writes MediaFile.taggedKinIds). Read + tag only: no downloads (operator hold),
 * uploads stay on the per-entity surfaces.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun GalleryScreen() {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val client = remember { FirestoreClient() }

    // #898: a failed read used to show "No media uploaded yet", indistinguishable
    // from an actually-empty library. rememberLiveRead keeps the last good page on
    // a dropped poll and surfaces the error instead of silently going empty.
    val mediaRead = rememberLiveRead { client.allMediaStream() }
    val kinResult by remember { client.allKinStream() }.collectAsState(initial = FirestoreResult.Loading)
    val kinfolkResult by remember { client.kinfolkStream() }.collectAsState(initial = FirestoreResult.Loading)

    val allMedia = mediaRead.data ?: emptyList()
    val allKin = (kinResult as? FirestoreResult.Data)?.value ?: emptyList()
    val allKinfolk = (kinfolkResult as? FirestoreResult.Data)?.value ?: emptyList()
    val kinById = remember(allKin) { allKin.associateBy { it._id } }
    val kinfolkLabel = remember(allKinfolk) { allKinfolk.associate { it._id to kinfolkDisplayName(it) } }
    // #1564: the uploader line names a person, not the uid an upload stores.
    val uploaderNames = rememberUploaderNames(client)

    var filter by remember { mutableStateOf(GalleryFilter()) }
    var selected by remember { mutableStateOf<MediaFile?>(null) }

    // #3 (2026-06-08): upload media from the gallery. Pick a household, then the
    // platform picker opens; the upload writes a media_files doc stamped with that
    // household's kinfolkId so kin-tagging scopes correctly.
    val uploadScope = rememberReportingScope()
    var uploadPickerOpen by remember { mutableStateOf(false) }
    // #1588: the dialog's step. null = the Household / Kin choice; a household id
    // then lists that household (to upload to it, or to pick one of its kin).
    var uploadStep by remember { mutableStateOf<UploadStep>(UploadStep.Type) }
    var uploadBusy by remember { mutableStateOf(false) }
    var uploadToast by remember { mutableStateOf<Pair<String, ToastKind>?>(null) }
    fun uploadTo(entityId: String, entityType: String, targetName: String, kinfolkId: String = "") {
        uploadPickerOpen = false
        uploadStep = UploadStep.Type
        if (uploadBusy) return
        uploadBusy = true
        uploadScope.launch {
            // Run-4 #4b: multi-file upload (was single). Empty result = picker cancelled.
            uploadToast = when (val r = client.pickAndUploadMedia(entityId, entityType, max = 10, kinfolkId = kinfolkId)) {
                is WriteResult.Ok ->
                    if (r.value.isEmpty()) "Upload cancelled" to ToastKind.Info
                    else "Uploaded ${r.value.size} ${if (r.value.size == 1) "file" else "files"} to $targetName" to ToastKind.Success
                is WriteResult.Err ->
                    if (r.message.contains("no file", ignoreCase = true)) "Upload cancelled" to ToastKind.Info
                    else "Upload failed: ${r.message}" to ToastKind.Error
            }
            uploadBusy = false
        }
    }

    val months = remember(allMedia) { galleryMonths(allMedia) }
    val types = remember(allMedia) { galleryFileTypes(allMedia) }
    val kinfolkIds = remember(allMedia) { galleryKinfolkIds(allMedia) }
    val shown = remember(allMedia, filter) { filterGalleryMedia(allMedia, filter) }

    val glyphs = MediaCellGlyphs(play = Lucide.Play, document = Lucide.FileText, audio = Lucide.Music, broken = Lucide.Images)

    Box(modifier = Modifier.fillMaxSize()) {
        ScreenScaffold {
            DenScreenHeading(
                kicker = "The Den · Gallery",
                title = "Every",
                accentTail = "moment.",
                subtitle = "All media from every KinTale, tagged to its household. Tap a photo to tag the kin in it.",
                trailing = {
                    PrimaryButton(
                        label = if (uploadBusy) "Uploading…" else "Upload media",
                        enabled = !uploadBusy && allKinfolk.isNotEmpty(),
                        onClick = { uploadPickerOpen = true },
                    )
                },
            )
            uploadToast?.let { (msg, kind) ->
                Spacer(Modifier.height(dims.space3))
                StatusToast(visible = true, message = msg, kind = kind, onDismiss = { uploadToast = null })
            }
            Spacer(Modifier.height(dims.space4))

            // Household filter (can be many -> a horizontally scrollable chip row).
            if (kinfolkIds.isNotEmpty()) {
                FilterLabel("Household")
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Chip("All", filter.kinfolkId == null) { filter = filter.copy(kinfolkId = null) }
                    kinfolkIds.forEach { id ->
                        Chip(kinfolkLabel[id] ?: "Household", filter.kinfolkId == id) {
                            filter = filter.copy(kinfolkId = if (filter.kinfolkId == id) null else id)
                        }
                    }
                }
                Spacer(Modifier.height(dims.space3))
            }

            // Type + month filters.
            if (types.isNotEmpty()) {
                FilterLabel("Type")
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Chip("All", filter.fileType == null) { filter = filter.copy(fileType = null) }
                    types.forEach { t ->
                        Chip(t.lowercase().replaceFirstChar { it.uppercase() }, filter.fileType == t) {
                            filter = filter.copy(fileType = if (filter.fileType == t) null else t)
                        }
                    }
                }
                Spacer(Modifier.height(dims.space3))
            }
            if (months.isNotEmpty()) {
                FilterLabel("Month")
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Chip("All", filter.monthPrefix == null) { filter = filter.copy(monthPrefix = null) }
                    months.forEach { m ->
                        Chip(m, filter.monthPrefix == m) {
                            filter = filter.copy(monthPrefix = if (filter.monthPrefix == m) null else m)
                        }
                    }
                }
                Spacer(Modifier.height(dims.space4))
            }

            ReadStatusBanner(mediaRead, "media")
            when {
                mediaRead.snapshot.loading -> Text("Loading media...", style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                mediaRead.snapshot.failed -> Unit // ReadStatusBanner above already says why
                allMedia.isEmpty() -> Text("No media uploaded yet. Photos and videos from KinTales show up here.", style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                shown.isEmpty() -> Text("No media matches these filters.", style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                else -> {
                    Text("${shown.size} of ${allMedia.size}", style = AuntieTheme.typography.labelSmall, color = c.textFaint)
                    Spacer(Modifier.height(dims.space2))
                    FlowRow(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        shown.forEach { m ->
                            AuntieMediaCell(
                                media = m,
                                modifier = Modifier.width(132.dp),
                                onClick = { selected = m },
                                showCaption = true,
                                glyphs = glyphs,
                                uploaderNames = uploaderNames,
                            )
                        }
                    }
                }
            }
            Spacer(Modifier.height(dims.space5))
        }

        selected?.let { media ->
            TagKinOverlay(
                media = media,
                kin = taggableKin(media, allKin),
                kinById = kinById,
                householdLabels = kinfolkLabel,
                onDismiss = { selected = null },
                onSave = { ids ->
                    client.updateMediaTags(media._id, ids)
                },
            )
        }

        // #3 / #1588: pick where the upload goes (the platform file picker opens
        // after). Household, or Kin: a household first, then one of ITS kin. The
        // kin id is never typed.
        val closeUploadPicker = { uploadPickerOpen = false; uploadStep = UploadStep.Type }
        val step = uploadStep
        AuntieDialog(
            visible = uploadPickerOpen,
            title = when (step) {
                UploadStep.Type -> "Where should this upload go?"
                is UploadStep.Household -> if (step.forKin) "Which household is the kin in?" else "Upload to which household?"
                is UploadStep.PetOf -> "Which kin in ${kinfolkDisplayName(step.household)}?"
            },
            hint = "The file picker opens next.",
            onDismiss = closeUploadPicker,
        ) {
            Column(
                modifier = Modifier.fillMaxWidth().heightIn(max = 420.dp).verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(dims.space2),
            ) {
                @Composable
                fun Choice(label: String, onClick: () -> Unit) {
                    Row(
                        modifier = Modifier.fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .clickable(onClick = onClick)
                            .background(c.surface2)
                            .padding(dims.space3),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(label, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                    }
                }
                @Composable
                fun Hint(text: String) = Text(text, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                when (step) {
                    UploadStep.Type -> {
                        Choice("Household") { uploadStep = UploadStep.Household(forKin = false) }
                        Choice("Kin (pet)") { uploadStep = UploadStep.Household(forKin = true) }
                    }
                    is UploadStep.Household -> {
                        if (kinfolkResult is FirestoreResult.Loading) Hint("Loading households…")
                        else if (allKinfolk.isEmpty()) Hint("No households yet.")
                        else allKinfolk.sortedBy { kinfolkDisplayName(it) }.forEach { kf ->
                            Choice(kinfolkDisplayName(kf)) {
                                if (step.forKin) uploadStep = UploadStep.PetOf(kf)
                                else uploadTo(kf._id, "kinfolk", kinfolkDisplayName(kf))
                            }
                        }
                        GhostButton(label = "Back", onClick = { uploadStep = UploadStep.Type })
                    }
                    is UploadStep.PetOf -> {
                        val pets = uploadableKin(allKin, step.household._id)
                        if (kinResult is FirestoreResult.Loading) Hint("Loading kin…")
                        else if (kinResult !is FirestoreResult.Data) Hint("Couldn't load the kin roster, so there is nothing to choose from.")
                        else if (pets.isEmpty()) Hint("No kin on this household yet.")
                        else pets.forEach { pet ->
                            Choice(pet.name.ifBlank { "Unnamed" }) {
                                uploadTo(pet._id, "kin", pet.name.ifBlank { "Unnamed" }, kinfolkId = step.household._id)
                            }
                        }
                        GhostButton(label = "Back", onClick = { uploadStep = UploadStep.Household(forKin = true) })
                    }
                }
            }
        }
    }
}
/** Where the Gallery's Upload dialog is (#1588): the Household / Kin choice, a household list, or one household's kin. */
private sealed class UploadStep {
    object Type : UploadStep()
    /** [forKin] true: choosing the household a pet belongs to; false: choosing the household to upload to. */
    data class Household(val forKin: Boolean) : UploadStep()
    data class PetOf(val household: Kinfolk) : UploadStep()
}
private fun kinfolkDisplayName(k: Kinfolk): String =
    k.lastName.ifBlank { k._id.take(6) }

@Composable
private fun FilterLabel(text: String) {
    Text(
        text = text.uppercase(),
        style = AuntieTheme.typography.labelSmall,
        color = AuntieTheme.colors.textFaint,
        modifier = Modifier.padding(bottom = 6.dp),
    )
}

@Composable
private fun Chip(label: String, selected: Boolean, onClick: () -> Unit) {
    val c = AuntieTheme.colors
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(if (selected) c.textPrimary else c.surfaceGlass)
            .border(AuntieTheme.dims.borderHairline, if (selected) c.textPrimary else c.border, RoundedCornerShape(999.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 6.dp),
    ) {
        Text(
            text = label,
            style = AuntieTheme.typography.labelSmall,
            color = if (selected) c.background else c.textDim,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * Tag-kin overlay: a scrim + centered card listing the kin taggable for this media
 * (scoped to its household). Toggle kin, Save writes taggedKinIds via the client.
 * Fail-loud: a write error stays on the card; success closes it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TagKinOverlay(
    media: MediaFile,
    kin: List<Kin>,
    kinById: Map<String, Kin>,
    /** Household display names by id (#1604): the headings over a whole-roster list, and the household named on a scoped one. */
    householdLabels: Map<String, String>,
    onDismiss: () -> Unit,
    onSave: suspend (List<String>) -> WriteResult<Unit>,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val scope = rememberReportingScope()
    val picked: SnapshotStateList<String> = remember(media._id) { mutableStateListOf<String>().apply { addAll(media.taggedKinIds) } }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(c.background.copy(alpha = 0.72f))
            .clickable(onClick = onDismiss),
        contentAlignment = Alignment.Center,
    ) {
        // Inner card swallows clicks so taps inside don't dismiss.
        GlassSurface(
            cornerRadius = 18.dp,
            modifier = Modifier.widthIn(max = 460.dp).padding(dims.space4)
                .clickable(indication = null, interactionSource = remember { MutableInteractionSource() }) {},
        ) {
            Column(modifier = Modifier.padding(dims.space4)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Tag kin in this photo", style = AuntieTheme.typography.titleLarge, color = c.textPrimary, modifier = Modifier.weight(1f))
                    GhostButton(label = "Close", onClick = onDismiss)
                }
                Spacer(Modifier.height(dims.space3))
                val scoped = media.kinfolkId.isNotBlank()
                if (scoped) {
                    householdLabels[media.kinfolkId]?.takeIf { it.isNotBlank() }?.let {
                        Text("Household: $it", style = AuntieTheme.typography.bodySmall, color = c.textDim)
                        Spacer(Modifier.height(dims.space2))
                    }
                }
                if (kin.isEmpty()) {
                    Text("No kin on this household to tag.", style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                } else {
                    // A file with a household offers that household's kin: one flat list is
                    // unambiguous. A file with none offers the whole roster (#1604), so group
                    // it under each household's name to tell same-named pets apart.
                    val groups = if (scoped) listOf(KinHouseholdGroup("", "", kin))
                    else groupKinByHousehold(kin) { householdLabels[it] }
                    Column(
                        modifier = Modifier.fillMaxWidth().heightIn(max = 320.dp).verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        groups.forEach { group ->
                            if (!scoped) {
                                Text(
                                    group.label,
                                    style = AuntieTheme.typography.labelSmall,
                                    color = c.textDim,
                                    modifier = Modifier.padding(top = 8.dp, start = 6.dp),
                                )
                            }
                            group.kin.forEach { k ->
                                val on = picked.contains(k._id)
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clip(RoundedCornerShape(10.dp))
                                        .clickable {
                                            if (on) picked.remove(k._id) else picked.add(k._id)
                                        }
                                        .padding(vertical = 8.dp, horizontal = 6.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                                ) {
                                    CheckBox(on)
                                    Column(modifier = Modifier.weight(1f)) {
                                        Text(k.name.ifBlank { "Unnamed" }, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                                        val sub = listOf(k.species, k.breed).filter { it.isNotBlank() }.joinToString(" · ")
                                        if (sub.isNotBlank()) Text(sub, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                                    }
                                }
                            }
                        }
                    }
                }
                error?.let {
                    Spacer(Modifier.height(dims.space2))
                    Text("Save failed: $it", style = AuntieTheme.typography.bodySmall, color = c.error)
                }
                Spacer(Modifier.height(dims.space3))
                PrimaryButton(
                    label = if (saving) "Saving..." else "Save tags",
                    loading = saving,
                    enabled = !saving,
                    onClick = {
                        saving = true
                        error = null
                        scope.launch {
                            when (val r = onSave(picked.toList())) {
                                is WriteResult.Ok -> { saving = false; onDismiss() }
                                is WriteResult.Err -> { saving = false; error = r.message }
                            }
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

/** Square check indicator (no M3 Checkbox): filled brand box with a check glyph when on. */
@Composable
private fun CheckBox(on: Boolean) {
    val c = AuntieTheme.colors
    Box(
        modifier = Modifier
            .width(20.dp).height(20.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(if (on) c.primary else c.surface2)
            .border(AuntieTheme.dims.borderHairline, if (on) c.primary else c.border, RoundedCornerShape(6.dp)),
        contentAlignment = Alignment.Center,
    ) {
        if (on) {
            androidx.compose.foundation.Image(
                painter = androidx.compose.ui.graphics.vector.rememberVectorPainter(Lucide.Check),
                contentDescription = null,
                colorFilter = androidx.compose.ui.graphics.ColorFilter.tint(c.background),
                modifier = Modifier.width(13.dp).height(13.dp),
            )
        }
    }
}