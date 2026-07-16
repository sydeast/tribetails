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
import com.tribetails.auntieos.web.ui.components.StatusToast
import com.tribetails.auntieos.web.ui.components.ToastKind
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

    val mediaResult by remember { client.allMediaStream() }.collectAsState(initial = FirestoreResult.Loading)
    val kinResult by remember { client.allKinStream() }.collectAsState(initial = FirestoreResult.Loading)
    val kinfolkResult by remember { client.kinfolkStream() }.collectAsState(initial = FirestoreResult.Loading)

    val allMedia = (mediaResult as? FirestoreResult.Data)?.value ?: emptyList()
    val allKin = (kinResult as? FirestoreResult.Data)?.value ?: emptyList()
    val allKinfolk = (kinfolkResult as? FirestoreResult.Data)?.value ?: emptyList()
    val kinById = remember(allKin) { allKin.associateBy { it._id } }
    val kinfolkLabel = remember(allKinfolk) { allKinfolk.associate { it._id to kinfolkDisplayName(it) } }

    var filter by remember { mutableStateOf(GalleryFilter()) }
    var selected by remember { mutableStateOf<MediaFile?>(null) }

    // #3 (2026-06-08): upload media from the gallery. Pick a household, then the
    // platform picker opens; the upload writes a media_files doc stamped with that
    // household's kinfolkId so kin-tagging scopes correctly.
    val uploadScope = rememberReportingScope()
    var uploadPickerOpen by remember { mutableStateOf(false) }
    var uploadBusy by remember { mutableStateOf(false) }
    var uploadToast by remember { mutableStateOf<Pair<String, ToastKind>?>(null) }
    fun uploadTo(kinfolkId: String, householdName: String) {
        uploadPickerOpen = false
        if (uploadBusy) return
        uploadBusy = true
        uploadScope.launch {
            // Run-4 #4b: multi-file upload (was single). Empty result = picker cancelled.
            uploadToast = when (val r = client.pickAndUploadMedia(kinfolkId, "kinfolk", max = 10)) {
                is WriteResult.Ok ->
                    if (r.value.isEmpty()) "Upload cancelled" to ToastKind.Info
                    else "Uploaded ${r.value.size} ${if (r.value.size == 1) "file" else "files"} to $householdName" to ToastKind.Success
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

            when {
                mediaResult is FirestoreResult.Loading -> Text("Loading media...", style = AuntieTheme.typography.bodyMedium, color = c.textDim)
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
                onDismiss = { selected = null },
                onSave = { ids ->
                    client.updateMediaTags(media._id, ids)
                },
            )
        }

        // #3: pick the household to upload to (the platform file picker opens after).
        AuntieDialog(
            visible = uploadPickerOpen,
            title = "Upload to which household?",
            hint = "Pick the household this media belongs to. The file picker opens next.",
            onDismiss = { uploadPickerOpen = false },
        ) {
            if (allKinfolk.isEmpty()) {
                Text("No households yet.", style = AuntieTheme.typography.bodySmall, color = c.textDim)
            } else {
                Column(
                    modifier = Modifier.fillMaxWidth().heightIn(max = 420.dp).verticalScroll(rememberScrollState()),
                    verticalArrangement = Arrangement.spacedBy(dims.space2),
                ) {
                    allKinfolk.sortedBy { kinfolkDisplayName(it) }.forEach { kf ->
                        Row(
                            modifier = Modifier.fillMaxWidth()
                                .clip(RoundedCornerShape(10.dp))
                                .clickable { uploadTo(kf._id, kinfolkDisplayName(kf)) }
                                .background(c.surface2)
                                .padding(dims.space3),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(kinfolkDisplayName(kf), style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
                        }
                    }
                }
            }
        }
    }
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
                if (kin.isEmpty()) {
                    Text("No kin on this household to tag.", style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                } else {
                    Column(
                        modifier = Modifier.fillMaxWidth().heightIn(max = 320.dp).verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        kin.forEach { k ->
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