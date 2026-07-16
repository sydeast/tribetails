package com.tribetails.auntieos.ui.media

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.lifecycle.viewmodel.compose.viewModel
import coil3.compose.AsyncImage
import coil3.request.ImageRequest
import coil3.request.crossfade
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.FileText
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Music
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.MediaFile
import com.tribetails.auntieos.data.model.MediaType
import com.tribetails.auntieos.domain.GalleryFilter
import com.tribetails.auntieos.domain.filterGalleryMedia
import com.tribetails.auntieos.domain.galleryFileTypes
import com.tribetails.auntieos.domain.galleryKinfolkIds
import com.tribetails.auntieos.domain.galleryMonths
import com.tribetails.auntieos.domain.taggableKin
import com.tribetails.auntieos.domain.taggedKinNames
import com.tribetails.auntieos.ui.components.AuntieCard
import com.tribetails.auntieos.ui.components.AuntieChip
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * #13 global Gallery (android): all business media across every KinTale/entity in one
 * place, filterable by household / type / month, with per-image kin tagging. Read +
 * tag only (no downloads, no upload here). Mirrors the web GalleryScreen.
 */
@Composable
fun GalleryScreen(
    viewModel: GalleryViewModel = viewModel(),
    uploadViewModel: MediaUploadViewModel = viewModel(),
    onBack: () -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    var selected by remember { mutableStateOf<MediaFile?>(null) }
    // A1 (A8): tapping a tile opens a full-size viewer (was: jumped straight to tagging).
    var pendingView by remember { mutableStateOf<MediaFile?>(null) }
    // #3 (2026-06-08): upload from the gallery. Pick a household, then the system
    // media picker opens (MediaPickerDialog); the upload stamps that household's
    // kinfolkId so kin-tagging scopes correctly.
    var showHouseholdPicker by remember { mutableStateOf(false) }
    var uploadHousehold by remember { mutableStateOf<com.tribetails.auntieos.data.model.Kinfolk?>(null) }

    androidx.compose.runtime.LaunchedEffect(Unit) { viewModel.load() }

    val shown = filterGalleryMedia(state.media, state.filter)
    val months = galleryMonths(state.media)
    val types = galleryFileTypes(state.media)
    val kinfolkIds = galleryKinfolkIds(state.media)
    val kinfolkLabel = state.kinfolk.associate { it.id to it.lastName.ifBlank { it.id.take(6) } }
    val kinById = state.kin.associateBy { it.id }

    AuntieScreenScaffold(title = "Gallery", onBack = onBack) {
        Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
            Text(
                "All media from every KinTale, tagged to its household. Tap a photo to tag the kin in it.",
                style = AuntieTheme.typography.bodySmall,
                color = AuntieTheme.colors.textDim,
            )
            Spacer(Modifier.height(12.dp))
            PrimaryButton(
                label = "Upload media",
                onClick = { showHouseholdPicker = true },
                enabled = state.kinfolk.isNotEmpty(),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(12.dp))

            if (kinfolkIds.isNotEmpty()) {
                FilterRow(
                    label = "Household",
                    options = listOf(null) + kinfolkIds,
                    labelOf = { it?.let { id -> kinfolkLabel[id] ?: "Household" } ?: "All" },
                    selected = state.filter.kinfolkId,
                    onSelect = { viewModel.setFilter(state.filter.copy(kinfolkId = it)) },
                )
            }
            if (types.isNotEmpty()) {
                FilterRow(
                    label = "Type",
                    options = listOf<MediaType?>(null) + types,
                    labelOf = { it?.name?.lowercase()?.replaceFirstChar { c -> c.uppercase() } ?: "All" },
                    selected = state.filter.fileType,
                    onSelect = { viewModel.setFilter(state.filter.copy(fileType = it)) },
                )
            }
            if (months.isNotEmpty()) {
                FilterRow(
                    label = "Month",
                    options = listOf(null) + months,
                    labelOf = { it ?: "All" },
                    selected = state.filter.monthPrefix,
                    onSelect = { viewModel.setFilter(state.filter.copy(monthPrefix = it)) },
                )
            }
            Spacer(Modifier.height(8.dp))

            when {
                state.isLoading -> Text("Loading media...", style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textDim)
                state.error != null -> Text(state.error!!, style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.error)
                state.media.isEmpty() -> Text("No media uploaded yet. Photos and videos from KinTales show up here.", style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textDim)
                shown.isEmpty() -> Text("No media matches these filters.", style = AuntieTheme.typography.bodyMedium, color = AuntieTheme.colors.textDim)
                else -> {
                    Text("${shown.size} of ${state.media.size}", style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textFaint)
                    Spacer(Modifier.height(6.dp))
                    LazyVerticalGrid(
                        columns = GridCells.Adaptive(110.dp),
                        modifier = Modifier.fillMaxSize().weight(1f),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        items(shown) { media ->
                            GalleryThumb(
                                media = media,
                                taggedNames = taggedKinNames(media, kinById),
                                onClick = { pendingView = media },
                            )
                        }
                    }
                }
            }
        }
    }

    // A1: full-size viewer. "Tag kin" hands off to the existing tag dialog.
    pendingView?.let { media ->
        MediaViewerDialog(
            media = media,
            taggedNames = taggedKinNames(media, kinById),
            onTag = { selected = media; pendingView = null },
            onDismiss = { pendingView = null },
        )
    }

    selected?.let { media ->
        TagKinDialog(
            media = media,
            kin = taggableKin(media, state.kin),
            onDismiss = { selected = null },
            onSave = { ids -> viewModel.saveTags(media.id, ids) { ok -> if (ok) selected = null } },
        )
    }

    // #3: choose which household this upload belongs to.
    if (showHouseholdPicker) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { showHouseholdPicker = false },
            confirmButton = {},
            title = { Text("Upload to which household?") },
            text = {
                androidx.compose.foundation.lazy.LazyColumn(
                    modifier = Modifier.heightIn(max = 360.dp),
                ) {
                    items(state.kinfolk.size) { i ->
                        val kf = state.kinfolk[i]
                        Text(
                            text = kf.displayName,
                            style = AuntieTheme.typography.bodyLarge,
                            color = AuntieTheme.colors.textPrimary,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { showHouseholdPicker = false; uploadHousehold = kf }
                                .padding(vertical = 12.dp),
                        )
                    }
                }
            },
        )
    }

    // #3: once a household is chosen, the system media picker + upload runs. The
    // upload stamps kinfolkId (entityType KINFOLK -> entityId is the kinfolkId).
    uploadHousehold?.let { kf ->
        MediaPickerDialog(
            entityId = kf.id,
            entityType = com.tribetails.auntieos.data.model.MediaEntityType.KINFOLK,
            entityName = kf.displayName,
            onDismiss = { uploadHousehold = null },
            onMediaUploaded = { uploadHousehold = null; viewModel.load() },
            viewModel = uploadViewModel,
        )
    }
}

@Composable
private fun <T> FilterRow(
    label: String,
    options: List<T>,
    labelOf: (T) -> String,
    selected: T,
    onSelect: (T) -> Unit,
) {
    Text(label.uppercase(), style = AuntieTheme.typography.labelSmall, color = AuntieTheme.colors.textFaint)
    Spacer(Modifier.height(4.dp))
    Row(
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        options.forEach { opt ->
            AuntieChip(
                onClick = { onSelect(if (opt == selected) options.first() else opt) },
                label = labelOf(opt),
                selected = opt == selected,
            )
        }
    }
    Spacer(Modifier.height(10.dp))
}

/**
 * A1 (A8): full-size media viewer. Tapping a tile opens this (instead of jumping
 * straight to tag-editing). Images render full-res; for video we show the poster and
 * say so plainly rather than faking inline playback. "Tag kin" hands off to the tag
 * dialog so tagging is still one tap away.
 */
@Composable
private fun MediaViewerDialog(
    media: MediaFile,
    taggedNames: List<String>,
    onTag: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = AuntieTheme.colors
    val context = LocalContext.current
    Dialog(onDismissRequest = onDismiss) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(16.dp))
                .background(c.surface)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            val isVisual = media.fileType == MediaType.IMAGE || media.fileType == MediaType.VIDEO
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 420.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(c.surface2),
                contentAlignment = Alignment.Center,
            ) {
                if (isVisual) {
                    AsyncImage(
                        model = ImageRequest.Builder(context)
                            .data(media.storageUrl.ifBlank { media.thumbnailUrl })
                            .crossfade(true)
                            .build(),
                        contentDescription = media.description.ifBlank { "Media" },
                        contentScale = ContentScale.Fit,
                        modifier = Modifier.fillMaxWidth().heightIn(max = 420.dp),
                    )
                } else {
                    Icon(
                        imageVector = if (media.fileType == MediaType.AUDIO) Lucide.Music else Lucide.FileText,
                        contentDescription = null,
                        tint = c.kinfolkOrange,
                        modifier = Modifier.size(56.dp),
                    )
                }
            }
            if (media.fileType == MediaType.VIDEO) {
                Text(
                    "Video preview — open the source to play.",
                    style = AuntieTheme.typography.labelSmall,
                    color = c.textDim,
                )
            }
            if (media.description.isNotBlank()) {
                Text(media.description, style = AuntieTheme.typography.bodyMedium, color = c.textPrimary)
            }
            if (taggedNames.isNotEmpty()) {
                Text(
                    "Tagged: ${taggedNames.joinToString(", ")}",
                    style = AuntieTheme.typography.labelSmall,
                    color = c.textDim,
                )
            }
            PrimaryButton(label = "Tag kin", onClick = onTag, modifier = Modifier.fillMaxWidth())
            Box(
                modifier = Modifier.fillMaxWidth().clickable(onClick = onDismiss).padding(8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text("Close", style = AuntieTheme.typography.labelLarge, color = c.textDim)
            }
        }
    }
}

@Composable
private fun GalleryThumb(media: MediaFile, taggedNames: List<String>, onClick: () -> Unit) {
    val c = AuntieTheme.colors
    val context = LocalContext.current
    Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.clickable(onClick = onClick)) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(1f)
                .clip(RoundedCornerShape(8.dp))
                .background(c.surface2)
                .border(0.5.dp, c.border, RoundedCornerShape(8.dp)),
            contentAlignment = Alignment.Center,
        ) {
            if (media.fileType == MediaType.IMAGE || media.fileType == MediaType.VIDEO) {
                AsyncImage(
                    model = ImageRequest.Builder(context)
                        .data(media.thumbnailUrl.ifBlank { media.storageUrl })
                        .crossfade(true)
                        .build(),
                    contentDescription = media.description.ifBlank { "Media" },
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize().clip(RoundedCornerShape(8.dp)),
                )
            } else {
                Icon(
                    imageVector = if (media.fileType == MediaType.AUDIO) Lucide.Music else Lucide.FileText,
                    contentDescription = null,
                    tint = c.kinfolkOrange,
                    modifier = Modifier.size(28.dp),
                )
            }
            if (taggedNames.isNotEmpty()) {
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomStart)
                        .padding(4.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .background(c.kinfolkOrange.copy(alpha = 0.92f))
                        .padding(horizontal = 7.dp, vertical = 2.dp),
                ) {
                    Text(
                        text = if (taggedNames.size == 1) taggedNames.first() else "${taggedNames.size} kin",
                        style = AuntieTheme.typography.labelSmall,
                        color = c.background,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

@Composable
private fun TagKinDialog(
    media: MediaFile,
    kin: List<Kin>,
    onDismiss: () -> Unit,
    onSave: (List<String>) -> Unit,
) {
    val c = AuntieTheme.colors
    val picked = remember(media.id) { mutableStateListOf<String>().apply { addAll(media.taggedKinIds) } }
    Dialog(onDismissRequest = onDismiss) {
        AuntieCard {
            Column(modifier = Modifier.padding(20.dp)) {
                Text("Tag kin in this photo", style = AuntieTheme.typography.titleLarge, color = c.textPrimary)
                Spacer(Modifier.height(12.dp))
                if (kin.isEmpty()) {
                    Text("No kin on this household to tag.", style = AuntieTheme.typography.bodyMedium, color = c.textDim)
                } else {
                    Column(
                        modifier = Modifier.fillMaxWidth().heightIn(max = 320.dp).verticalScroll(rememberScrollState()),
                        verticalArrangement = Arrangement.spacedBy(2.dp),
                    ) {
                        kin.forEach { k ->
                            val on = picked.contains(k.id)
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(10.dp))
                                    .clickable { if (on) picked.remove(k.id) else picked.add(k.id) }
                                    .padding(vertical = 8.dp, horizontal = 6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(20.dp)
                                        .clip(RoundedCornerShape(6.dp))
                                        .background(if (on) c.kinfolkOrange else c.surface2)
                                        .border(0.5.dp, if (on) c.kinfolkOrange else c.border, RoundedCornerShape(6.dp)),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    if (on) Icon(Lucide.Check, contentDescription = null, tint = c.background, modifier = Modifier.size(13.dp))
                                }
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(k.name.ifBlank { "Unnamed" }, style = AuntieTheme.typography.titleSmall, color = c.textPrimary)
                                    val sub = listOf(k.species, k.breed).filter { it.isNotBlank() }.joinToString(" · ")
                                    if (sub.isNotBlank()) Text(sub, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                                }
                            }
                        }
                    }
                }
                Spacer(Modifier.height(16.dp))
                PrimaryButton(label = "Save tags", onClick = { onSave(picked.toList()) })
            }
        }
    }
}
