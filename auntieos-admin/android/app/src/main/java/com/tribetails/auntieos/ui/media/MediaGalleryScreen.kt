package com.tribetails.auntieos.ui.media

import com.composables.icons.lucide.*
import com.composables.icons.lucide.Lucide
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import coil3.compose.AsyncImage
import coil3.request.ImageRequest
import coil3.request.crossfade
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.tribetails.auntieos.data.model.*
import com.tribetails.auntieos.ui.components.*
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme
import com.tribetails.auntieos.ui.components.LoadingScreen
import java.text.SimpleDateFormat
import java.util.*

@Composable
fun MediaGalleryScreen(
    entityId: String,
    entityType: MediaEntityType,
    entityName: String,
    viewModel: MediaGalleryViewModel = viewModel(),
    uploadViewModel: MediaUploadViewModel = viewModel(),
    onBack: () -> Unit
) {
    val state by viewModel.uiState.collectAsState()
    val filteredMedia = viewModel.filteredMedia
    var showUploadDialog by remember { mutableStateOf(false) }

    LaunchedEffect(entityId, entityType) {
        viewModel.loadMedia(entityId, entityType)
    }

    AuntieScreenScaffold(
        title = "$entityName Media",
        onBack = onBack,
        actions = {
            // Top-bar count chip (mock `.count`). The mock draws it inline after
            // the title; AuntieScreenScaffold's title is a plain String with no
            // composable slot, so the chip rides in the top bar's actions row
            // instead, ahead of the upload action. That keeps it in the bar the
            // mock puts it in without reworking the shared scaffold's signature.
            mediaCountChipLabel(
                isLoading = state.isLoading,
                error = state.error,
                count = state.mediaFiles.size,
            )?.let { MediaCountChip(label = it) }

            AuntieIconBtn(onClick = { showUploadDialog = true }) {
                Icon(Lucide.Plus, contentDescription = "Add Media")
            }
        },
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 16.dp)
        ) {
            // Media Type Filter
            MediaTypeFilter(
                selectedType = state.selectedMediaType,
                onTypeSelected = viewModel::filterByMediaType,
                mediaFiles = state.mediaFiles
            )

            Spacer(Modifier.height(16.dp))

            if (state.isLoading) {
                LoadingScreen(message = "Loading media...")
            } else if (state.error != null) {
                ErrorCard(error = state.error!!)
            } else if (filteredMedia.isEmpty()) {
                EmptyMediaState(
                    message = if (state.selectedMediaType != null) {
                        "No ${state.selectedMediaType!!.name.lowercase()} files found"
                    } else {
                        "No media files found"
                    }
                )
            } else {
                LazyVerticalGrid(
                    columns = GridCells.Fixed(3),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                    contentPadding = PaddingValues(vertical = 8.dp)
                ) {
                    items(filteredMedia) { mediaFile ->
                        MediaThumbnail(
                            mediaFile = mediaFile,
                            onDelete = { viewModel.deleteMediaFile(it) },
                            onSetProfile = { viewModel.setProfilePhoto(it) },
                            // #397 S3: the caption a file was uploaded with is no
                            // longer permanent on either client.
                            onSaveCaption = { id, caption -> viewModel.updateCaption(id, caption) },
                        )
                    }
                }
            }
        }
    }

    // Upload Dialog
    if (showUploadDialog) {
        MediaPickerDialog(
            entityId = entityId,
            entityType = entityType,
            entityName = entityName,
            onDismiss = { showUploadDialog = false },
            onMediaUploaded = { mediaFileIds ->
                // Refresh the media list after successful upload
                viewModel.loadMedia(entityId, entityType)
            },
            viewModel = uploadViewModel
        )
    }
}

@Composable
private fun MediaTypeFilter(
    selectedType: MediaType?,
    onTypeSelected: (MediaType?) -> Unit,
    mediaFiles: List<MediaFile>
) {
    AuntieCard {
        Column(
            modifier = Modifier.padding(16.dp)
        ) {
            Text(
                "MEDIA TYPE",
                style = AuntieTheme.typography.labelSmall,
                color = AuntieTheme.colors.kinfolkOrange
            )
            Spacer(Modifier.height(12.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                // All Types
                AuntieChip(
                    onClick = { onTypeSelected(null) },
                    label = "All (${mediaFiles.size})",
                    selected = selectedType == null,
                )

                // Individual Types
                MediaType.values().forEach { type ->
                    val count = mediaFiles.count { it.fileType == type }
                    if (count > 0) {
                        AuntieChip(
                            onClick = { onTypeSelected(type) },
                            label = "${type.name.lowercase().replaceFirstChar { it.uppercase() }} ($count)",
                            selected = selectedType == type,
                        )
                    }
                }
            }
        }
    }
}

@Composable
internal fun MediaThumbnail(
    mediaFile: MediaFile,
    // Takes the whole row, not an id: the delete callable cross-checks the
    // caller's entityId against the stored document (#397 S2).
    onDelete: (MediaFile) -> Unit,
    onSetProfile: (MediaFile) -> Unit = {},
    /** (mediaFileId, newCaption). Default no-op keeps every existing preview/test call site valid. */
    onSaveCaption: (String, String) -> Unit = { _, _ -> },
) {
    var showDeleteDialog by remember { mutableStateOf(false) }
    var showFullscreen by remember { mutableStateOf(false) }
    // #397 S3. Keyed on the media id so a caption dialog opened for one file can
    // never carry another file's draft after the grid re-composes.
    var showCaptionDialog by remember(mediaFile.id) { mutableStateOf(false) }
    var captionDraft by remember(mediaFile.id) { mutableStateOf(mediaFile.description) }
    val context = LocalContext.current

    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(1f)
            .clip(RoundedCornerShape(8.dp))
            .background(AuntieTheme.colors.surface2)
            .border(0.5.dp, AuntieTheme.colors.border, RoundedCornerShape(8.dp))
    ) {
        when (mediaFile.fileType) {
            MediaType.IMAGE -> {
                AsyncImage(
                    model = ImageRequest.Builder(context)
                        .data(mediaFile.thumbnailUrl.ifBlank { mediaFile.storageUrl })
                        .crossfade(true)
                        .build(),
                    contentDescription = mediaFile.description.ifBlank { "Image" },
                    modifier = Modifier
                        .fillMaxSize()
                        .clickable { showFullscreen = true },
                    contentScale = ContentScale.Crop
                )
            }
            MediaType.VIDEO -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .clickable { showFullscreen = true },
                    contentAlignment = Alignment.Center
                ) {
                    AsyncImage(
                        model = ImageRequest.Builder(context)
                            .data(mediaFile.thumbnailUrl.ifBlank { mediaFile.storageUrl })
                            .crossfade(true)
                            .build(),
                        contentDescription = "Video thumbnail",
                        modifier = Modifier.fillMaxSize(),
                        contentScale = ContentScale.Crop
                    )
                    // Play icon overlay
                    Box(
                        modifier = Modifier
                            .size(32.dp)
                            .clip(RoundedCornerShape(50))
                            .background(AuntieTheme.colors.background.copy(alpha = 0.7f)),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            Lucide.Play,
                            contentDescription = "Play",
                            tint = AuntieTheme.colors.kinfolkOrange,
                            modifier = Modifier.size(20.dp)
                        )
                    }
                }
            }
            MediaType.DOCUMENT -> {
                // #388 Android gap: this branch had no `clickable`, so a document
                // tile never opened `FullscreenMediaViewer` even though that
                // viewer already has a DOCUMENT/AUDIO branch ready (:485-505).
                // IMAGE/VIDEO above always had it; this just closes the gap.
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .clickable { showFullscreen = true }
                        .padding(8.dp),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Icon(
                        Lucide.FileText,
                        contentDescription = "Document",
                        tint = AuntieTheme.colors.kinfolkOrange,
                        modifier = Modifier.size(32.dp)
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = mediaFile.originalFileName,
                        style = AuntieTheme.typography.labelSmall,
                        color = AuntieTheme.colors.textPrimary,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
            MediaType.AUDIO -> {
                // #388 Android gap: same missing `clickable` as DOCUMENT above.
                Column(
                    modifier = Modifier
                        .fillMaxSize()
                        .clickable { showFullscreen = true }
                        .padding(8.dp),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Icon(
                        Lucide.Music,
                        contentDescription = "Audio",
                        tint = AuntieTheme.colors.kinfolkOrange,
                        modifier = Modifier.size(32.dp)
                    )
                    Spacer(Modifier.height(4.dp))
                    Text(
                        text = mediaFile.originalFileName,
                        style = AuntieTheme.typography.labelSmall,
                        color = AuntieTheme.colors.textPrimary,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis
                    )
                }
            }
        }

        // Delete button
        AuntieIconBtn(
            onClick = { showDeleteDialog = true },
            modifier = Modifier
                .align(Alignment.TopEnd)
                .size(24.dp)
        ) {
            Box(
                modifier = Modifier
                    .size(20.dp)
                    .clip(RoundedCornerShape(50))
                    .background(AuntieTheme.colors.background.copy(alpha = 0.8f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    Lucide.X,
                    contentDescription = "Delete",
                    tint = AuntieTheme.colors.error,
                    modifier = Modifier.size(14.dp)
                )
            }
        }

        // Profile-photo badge (spec 28 item 2; bound to the real field), or, on a
        // non-profile image, a "set as profile" action (slice 7) at the same anchor.
        if (mediaFile.isProfilePhoto) {
            ProfileBadge(
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .padding(6.dp),
            )
        } else if (mediaFile.fileType == MediaType.IMAGE) {
            AuntieIconBtn(
                onClick = { onSetProfile(mediaFile) },
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .padding(6.dp)
                    .size(24.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(20.dp)
                        .clip(RoundedCornerShape(50))
                        .background(AuntieTheme.colors.background.copy(alpha = 0.8f)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Lucide.Star,
                        contentDescription = "Set as profile photo",
                        tint = AuntieTheme.colors.accent,
                        modifier = Modifier.size(13.dp),
                    )
                }
            }
        }

        // File info overlay
        Box(
            modifier = Modifier
                .align(Alignment.BottomStart)
                .background(
                    AuntieTheme.colors.background.copy(alpha = 0.8f),
                    RoundedCornerShape(topEnd = 4.dp)
                )
                .padding(4.dp)
        ) {
            Text(
                text = formatFileSize(mediaFile.fileSizeBytes),
                style = AuntieTheme.typography.labelSmall,
                color = AuntieTheme.colors.textPrimary
            )
        }
    }

        // Caption: real description + meta (uploadedAt date · uploadedBy), spec 28
        // item 3. Fabricated/blank parts are omitted, never printed (fail loud over
        // fake): a blank or placeholder "auntie" author drops out.
        val caption = mediaFile.description.ifBlank { mediaFile.originalFileName }
        if (caption.isNotBlank()) {
            Text(
                text = caption,
                style = AuntieTheme.typography.titleSmall,
                color = AuntieTheme.colors.textPrimary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth(),
            )
        }
        val meta = mediaMetaLine(mediaFile.uploadedAt, mediaFile.uploadedBy)
        if (meta.isNotBlank()) {
            Text(
                text = meta,
                style = AuntieTheme.typography.labelSmall,
                color = AuntieTheme.colors.textDim,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }

    if (showDeleteDialog) {
        AuntieModal(
            onDismissRequest = { showDeleteDialog = false },
            title = "Delete Media",
            confirmButton = {
                PrimaryButton(
                    label = "Delete",
                    onClick = {
                        onDelete(mediaFile)
                        showDeleteDialog = false
                    }
                )
            },
            dismissButton = {
                AuntieTextBtn(onClick = { showDeleteDialog = false }) {
                    Text("Cancel")
                }
            }
        ) {
            Text("Are you sure you want to delete this ${mediaFile.fileType.name.lowercase()}?")
        }
    }

    if (showFullscreen) {
        FullscreenMediaViewer(
            mediaFile = mediaFile,
            onDismiss = { showFullscreen = false },
            onEditCaption = {
                // Seeded from the STORED description, never from the caption
                // shown: that falls back to the file name, and pre-filling with
                // "IMG_4821.jpg" would turn a fallback nobody typed into a real
                // stored caption on the first save.
                captionDraft = mediaFile.description
                showFullscreen = false
                showCaptionDialog = true
            },
        )
    }
    // #397 S3: the caption editor. Lives beside the delete confirm rather than
    // inside the fullscreen viewer, so the keyboard has room and the dialog is
    // dismissible the same way every other AuntieModal is.
    if (showCaptionDialog) {
        AuntieModal(
            onDismissRequest = { showCaptionDialog = false },
            title = "Edit caption",
            confirmButton = {
                PrimaryButton(
                    label = "Save caption",
                    onClick = {
                        onSaveCaption(mediaFile.id, captionDraft)
                        showCaptionDialog = false
                    },
                )
            },
            dismissButton = {
                AuntieTextBtn(onClick = { showCaptionDialog = false }) {
                    Text("Cancel")
                }
            },
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                AuntieField(
                    value = captionDraft,
                    onValueChange = { captionDraft = it },
                    label = "Caption",
                    singleLine = false,
                    minLines = 3,
                )
                Text(
                    text = "Leave it empty to go back to showing the file name.",
                    style = AuntieTheme.typography.labelSmall,
                    color = AuntieTheme.colors.textDim,
                )
            }
        }
    }
}

/**
 * Fullscreen overlay for IMAGE / VIDEO media files. Uses ContentScale.Fit so
 * tall portraits and wide landscapes show end-to-end with letterboxing rather
 * than being cropped. Backdrop is the theme background so the photo isn't
 * jarring on a dark device theme. Tap anywhere to dismiss, plus an explicit
 * close button in the top-right for accessibility.
 *
 * Video files render the thumbnail at full-bleed with a play overlay - the
 * actual playback controls are a separate concern (no ExoPlayer dep wired
 * yet). The thumbnail-only branch makes the gallery still navigable for
 * videos without crashing on missing-codec edge cases.
 */
@Composable
private fun FullscreenMediaViewer(
    mediaFile: MediaFile,
    onDismiss: () -> Unit,
    /** Hands off to the caption editor (#397 S3). Default no-op for any caller that has none. */
    onEditCaption: () -> Unit = {},
) {
    val context = LocalContext.current
    Dialog(
        onDismissRequest = onDismiss,
        properties       = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Box(
            modifier = Modifier
                .fillMaxSize()
                .background(AuntieTheme.colors.background)
                .clickable(onClick = onDismiss),
            contentAlignment = Alignment.Center,
        ) {
            when (mediaFile.fileType) {
                MediaType.IMAGE, MediaType.VIDEO -> {
                    AsyncImage(
                        model = ImageRequest.Builder(context)
                            .data(mediaFile.storageUrl.ifBlank { mediaFile.thumbnailUrl })
                            .crossfade(true)
                            .build(),
                        contentDescription = mediaFile.description.ifBlank { mediaFile.originalFileName },
                        modifier     = Modifier.fillMaxSize(),
                        contentScale = ContentScale.Fit,
                    )
                    if (mediaFile.fileType == MediaType.VIDEO) {
                        Box(
                            modifier = Modifier
                                .size(72.dp)
                                .clip(RoundedCornerShape(50))
                                .background(AuntieTheme.colors.background.copy(alpha = 0.6f)),
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                Lucide.Play,
                                contentDescription = "Play",
                                tint     = AuntieTheme.colors.kinfolkOrange,
                                modifier = Modifier.size(36.dp),
                            )
                        }
                    }
                }
                else -> {
                    // Documents/audio: no inline viewer; surface filename + size.
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        Icon(
                            if (mediaFile.fileType == MediaType.AUDIO) Lucide.Music else Lucide.FileText,
                            contentDescription = null,
                            tint     = AuntieTheme.colors.kinfolkOrange,
                            modifier = Modifier.size(96.dp),
                        )
                        Text(
                            text  = mediaFile.originalFileName.ifBlank { "Untitled" },
                            style = AuntieTheme.typography.titleMedium,
                            color = AuntieTheme.colors.textPrimary,
                        )
                        Text(
                            text  = formatFileSize(mediaFile.fileSizeBytes),
                            style = AuntieTheme.typography.bodySmall,
                            color = AuntieTheme.colors.textDim,
                        )
                    }
                }
            }

            // Edit caption, left of Close. Placed in the viewer for the same
            // reason web puts it there: this is where the operator can actually
            // see the photo they are describing, which a 3-column thumbnail is
            // not.
            AuntieIconBtn(
                onClick  = onEditCaption,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(top = 16.dp, end = 64.dp)
                    .size(40.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(36.dp)
                        .clip(RoundedCornerShape(50))
                        .background(AuntieTheme.colors.background.copy(alpha = 0.85f))
                        .border(0.5.dp, AuntieTheme.colors.border, RoundedCornerShape(50)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Lucide.Pencil,
                        contentDescription = "Edit caption",
                        tint     = AuntieTheme.colors.textPrimary,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
            AuntieIconBtn(
                onClick  = onDismiss,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(16.dp)
                    .size(40.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(36.dp)
                        .clip(RoundedCornerShape(50))
                        .background(AuntieTheme.colors.background.copy(alpha = 0.85f))
                        .border(0.5.dp, AuntieTheme.colors.border, RoundedCornerShape(50)),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        Lucide.X,
                        contentDescription = "Close",
                        tint     = AuntieTheme.colors.textPrimary,
                        modifier = Modifier.size(20.dp),
                    )
                }
            }

            if (mediaFile.description.isNotBlank()) {
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .fillMaxWidth()
                        .background(AuntieTheme.colors.background.copy(alpha = 0.7f))
                        .padding(16.dp),
                ) {
                    Text(
                        text  = mediaFile.description,
                        style = AuntieTheme.typography.bodyMedium,
                        color = AuntieTheme.colors.textPrimary,
                    )
                }
            }
        }
    }
}

@Composable
private fun ErrorCard(error: String) {
    AuntieCard(containerColor = AuntieTheme.colors.errorContainer) {
        Text(
            text = error,
            modifier = Modifier.padding(16.dp),
            color = AuntieTheme.colors.error
        )
    }
}

@Composable
private fun EmptyMediaState(message: String) {
    AuntieCard(
        containerColor = AuntieTheme.colors.surface2,
        modifier = Modifier.fillMaxWidth()
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(48.dp),
            contentAlignment = Alignment.Center
        ) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Icon(
                    Lucide.Images,
                    contentDescription = null,
                    modifier = Modifier.size(64.dp),
                    tint = AuntieTheme.colors.textDim
                )
                Spacer(Modifier.height(16.dp))
                Text(
                    text = message,
                    style = AuntieTheme.typography.titleMedium,
                    color = AuntieTheme.colors.textDim
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    text = "Upload photos and videos to see them here",
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textDim
                )
            }
        }
    }
}

private fun formatFileSize(bytes: Long): String {
    if (bytes < 1024) return "$bytes B"
    val kb = bytes / 1024.0
    if (kb < 1024) return String.format("%.1f KB", kb)
    val mb = kb / 1024.0
    if (mb < 1024) return String.format("%.1f MB", mb)
    val gb = mb / 1024.0
    return String.format("%.1f GB", gb)
}

/**
 * Caption meta line for a media cell (spec 28 item 3): "{uploadedAt date} ·
 * {uploadedBy}", dropping any part that is blank or fabricated. Mirrors the web
 * `mediaMetaLine`: the ISO/Firestore [uploadedAt] is reduced to its YYYY-MM-DD
 * prefix (no date fabrication); a blank or placeholder "auntie" [uploadedBy] is
 * omitted rather than shown as a real author. Returns "" when nothing real
 * remains. Pure; unit-tested.
 */
internal fun mediaMetaLine(uploadedAt: String, uploadedBy: String): String {
    val date = uploadedAt.trim().take(10)
        .takeIf { it.length == 10 && it[4] == '-' && it[7] == '-' }
        .orEmpty()
    val author = uploadedBy.trim()
        .takeIf { it.isNotBlank() && !it.equals("auntie", ignoreCase = true) }
        .orEmpty()
    return listOf(date, author).filter { it.isNotBlank() }.joinToString(" · ")
}

/**
 * Label for the top-bar count chip, or `null` when the screen has no real number
 * to show.
 *
 * The gate is the point. A count chip drawn while [isLoading] is true, or after
 * the read failed ([error] non-null), would be stating "0 files" about a
 * collection nobody has successfully read yet, the same fabricated claim the
 * web StatCard was rewritten to make impossible. A stale [count] carried
 * alongside either of those states is not rescued by being non-zero, so both
 * gates run before the count is looked at.
 *
 * A proven-empty gallery also gets no chip: the empty state already says "No
 * media files found", and "0 files" beside it is noise, not information. Pure;
 * unit-tested.
 */
internal fun mediaCountChipLabel(isLoading: Boolean, error: String?, count: Int): String? {
    if (isLoading || error != null) return null
    if (count <= 0) return null
    return if (count == 1) "1 file" else "$count files"
}

/**
 * The mock's mono count pill for the top bar. Renders only the label it is
 * handed: the decision about whether a number is knowable lives in
 * [mediaCountChipLabel], so this composable has no fallback to get wrong.
 */
@Composable
internal fun MediaCountChip(label: String) {
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(AuntieTheme.colors.surface2)
            .border(
                AuntieTheme.dims.borderHairline,
                AuntieTheme.colors.border,
                RoundedCornerShape(50),
            )
            .padding(horizontal = 10.dp, vertical = 3.dp),
    ) {
        Text(
            text = label,
            style = AuntieTheme.typography.mono,
            color = AuntieTheme.colors.textDim,
        )
    }
}

/** Small teal "Profile" pill marking the household's profile photo (spec 28 item 2). */
@Composable
private fun ProfileBadge(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(AuntieTheme.colors.accent.copy(alpha = 0.92f))
            .padding(horizontal = 8.dp, vertical = 3.dp),
    ) {
        Text(
            text = "Profile",
            style = AuntieTheme.typography.labelSmall,
            color = AuntieTheme.colors.background,
        )
    }
}
