package com.tribetails.auntieos.web.screens.media

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.composables.icons.lucide.ArrowLeft
import com.composables.icons.lucide.FileText
import com.composables.icons.lucide.Images
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Music
import com.composables.icons.lucide.Play
import com.composables.icons.lucide.Plus
import com.composables.icons.lucide.Star
import com.composables.icons.lucide.X
import com.tribetails.auntieos.web.data.AuntieDataSource
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.FirestoreClient
import com.tribetails.auntieos.web.data.KinCareReport
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.MediaFile
import com.tribetails.auntieos.web.data.Payment
import androidx.compose.ui.layout.ContentScale
import coil3.compose.AsyncImage
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.AuntieBanner
import com.tribetails.auntieos.web.ui.components.AuntieBannerTone
import com.tribetails.auntieos.web.ui.components.AuntieChip
import com.tribetails.auntieos.web.ui.components.AuntieChipTone
import com.tribetails.auntieos.web.ui.components.AuntieDialog
import com.tribetails.auntieos.web.ui.components.AuntieEmptyState
import com.tribetails.auntieos.web.ui.components.AuntieIconButton
import com.tribetails.auntieos.web.ui.components.AuntieMediaCell
import com.tribetails.auntieos.web.ui.components.AuntieMediaGrid
import com.tribetails.auntieos.web.ui.components.AuntieProgressBar
import com.tribetails.auntieos.web.ui.components.GhostButton
import com.tribetails.auntieos.web.ui.components.MediaCellGlyphs
import com.tribetails.auntieos.web.ui.components.PrimaryButton
import com.tribetails.auntieos.web.ui.components.ScreenScaffold
import com.tribetails.auntieos.web.ui.components.ShimmerCard

/**
 * MediaGalleryScreen - the Den's photo / video / document / audio gallery for an
 * entity (kinfolk, visit log, etc.). Mirrors the redesign mockup
 * ui-ideas/auntieos-media-gallery-2026-05-27.html.
 *
 * Public signature, ViewModel, data source, and every callback are unchanged from
 * the shipped screen. The visual layer is rebuilt on the Den component kit:
 *  - A kick + Fraunces title header with a back affordance and an Upload action.
 *  - An indeterminate [AuntieProgressBar] while a file is uploading.
 *  - A fail-loud [AuntieBanner] surfacing FirestoreResult.Error verbatim.
 *  - An [AuntieMediaGrid] of [AuntieMediaCell] tiles (IMAGE / VIDEO / DOCUMENT /
 *    AUDIO branches, delete-on-hover) and an [AuntieDialog] delete confirmation.
 */
@Composable
fun MediaGalleryScreen(
    entityId: String,
    entityType: String,
    entityName: String,
    onBack: () -> Unit,
    dataSource: AuntieDataSource = remember { FirestoreClientMediaDataSource(FirestoreClient()) },
) {
    val vm = remember(entityId, entityType) {
        MediaGalleryViewModel(entityId = entityId, entityType = entityType, dataSource = dataSource)
    }
    val state by vm.uiState.collectAsState()

    // SUGGESTION: type-filter pills. The shipped screen has NO filters; this is a
    // pure view-layer slice over the real fileType field, additive only.
    var typeFilter by remember { mutableStateOf<String?>(null) }
    val visibleItems = remember(state.items, typeFilter) {
        typeFilter?.let { f -> state.items.filter { it.fileType.equals(f, ignoreCase = true) } }
            ?: state.items
    }

    ScreenScaffold {
        MediaGalleryHeader(
            entityName = entityName,
            count = state.items.size,
            onBack = onBack,
            onUpload = { vm.upload(byteArrayOf(), "image/jpeg") },
        )

        // Full-width upload progress, shown only while a file is uploading.
        if (state.isUploading) {
            Spacer(Modifier.height(4.dp))
            AuntieProgressBar(modifier = Modifier.fillMaxWidth(), height = 4.dp)
        }

        // Fail-loud error banner. Surfaces FirestoreResult.Error verbatim; dismiss
        // clears it (clearError). Never swallowed.
        state.error?.let { err ->
            Spacer(Modifier.height(12.dp))
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                icon = Lucide.X,
                onDismiss = vm::clearError,
            ) {
                Text(
                    text = err,
                    style = AuntieTheme.typography.bodySmall,
                    color = AuntieTheme.colors.textPrimary,
                )
            }
        }

        Spacer(Modifier.height(16.dp))

        when {
            state.isLoading -> LoadingState()
            state.items.isEmpty() -> EmptyMediaState()
            else -> {
                // SUGGESTION: type filter pills over the real items. Tagged inline.
                MediaTypeFilters(
                    items = state.items,
                    selected = typeFilter,
                    onSelect = { typeFilter = it },
                )
                Spacer(Modifier.height(14.dp))
                MediaGrid(
                    items = visibleItems,
                    onDelete = vm::deleteMedia,
                    onSetProfile = vm::setProfilePhoto,
                )
            }
        }
    }
}

/**
 * Header mirroring MediaGalleryTopBar: a back affordance, the "The Den · Media"
 * kick, the "$entityName Media" Fraunces title (entity name in primary, "Media"
 * in the pink secondary per the mockup), a SUGGESTION count chip, and the single
 * Upload action (the Plus IconButton, contentDescription "Upload Media").
 */
@Composable
private fun MediaGalleryHeader(
    entityName: String,
    count: Int,
    onBack: () -> Unit,
    onUpload: () -> Unit,
) {
    val c = AuntieTheme.colors
    Column(modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp)) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                AuntieIconButton(
                    icon = Lucide.ArrowLeft,
                    contentDescription = "Back",
                    onClick = onBack,
                    size = 40.dp,
                )
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        text = "THE DEN · MEDIA",
                        style = AuntieTheme.typography.mono.copy(fontSize = 11.sp, letterSpacing = 1.6.sp),
                        color = c.primary,
                    )
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        // Title == "$entityName Media". "Media" leans into the pink
                        // secondary per the mockup.
                        if (entityName.isNotBlank()) {
                            Text(
                                text = entityName,
                                style = AuntieTheme.typography.headlineLarge,
                                color = c.textPrimary,
                            )
                        }
                        Text(
                            text = "Media",
                            style = AuntieTheme.typography.headlineLarge.copy(fontWeight = FontWeight.Medium),
                            color = c.secondary,
                        )
                        // SUGGESTION: count chip, not in the shipped top bar.
                        if (count > 0) MediaCountChip(count = count)
                    }
                }
            }
            // Upload action == the Plus IconButton (contentDescription "Upload Media").
            PrimaryButton(
                label = "Upload Media",
                onClick = onUpload,
                leading = {
                    AuntieIconButton(
                        icon = Lucide.Plus,
                        contentDescription = "Upload Media",
                        onClick = onUpload,
                        size = 18.dp,
                    )
                },
            )
        }
    }
}

/** SUGGESTION: a mono count chip next to the title. Reflects the real item count. */
@Composable
private fun MediaCountChip(count: Int) {
    val c = AuntieTheme.colors
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background(c.surface2)
            .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(999.dp))
            .padding(horizontal = 10.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Text(
            text = "$count",
            style = AuntieTheme.typography.mono.copy(fontSize = 12.sp),
            color = c.accent,
        )
        Text(
            text = if (count == 1) "file" else "files",
            style = AuntieTheme.typography.mono.copy(fontSize = 12.sp),
            color = c.textDim,
        )
    }
}

/**
 * SUGGESTION: type-filter pills (All / Images / Videos / Documents / Audio). The
 * shipped MediaGalleryScreen has NO filters. These slice the real list by the
 * existing [MediaFile.fileType] field and never touch the backend. Counts come
 * from the live items. Tagged inline as additive.
 */
@Composable
private fun MediaTypeFilters(
    items: List<MediaFile>,
    selected: String?,
    onSelect: (String?) -> Unit,
) {
    // Derive per-type counts from the real items.
    val byType: Map<String, Int> = remember(items) {
        items.groupingBy { it.fileType.uppercase() }.eachCount()
    }
    val options: List<Pair<String?, String>> = listOf(
        null to "All",
        "IMAGE" to "Images",
        "VIDEO" to "Videos",
        "DOCUMENT" to "Documents",
        "AUDIO" to "Audio",
    )

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        options.forEach { (key, label) ->
            val count = if (key == null) items.size else (byType[key] ?: 0)
            AuntieChip(
                label = label,
                selected = selected == key,
                onClick = { onSelect(key) },
                trailingTag = "$count",
                tone = AuntieChipTone.Accent,
            )
        }
    }
}

@Composable
private fun LoadingState() {
    Column(
        modifier = Modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        repeat(2) { ShimmerCard(height = 160.dp) }
    }
}

@Composable
private fun EmptyMediaState() {
    // Copy verbatim from the shipped screen / mockup.
    AuntieEmptyState(
        title = "No media files found",
        message = "Upload photos and videos to see them here",
        icon = Lucide.Images,
    )
}

@Composable
private fun MediaGrid(
    items: List<MediaFile>,
    onDelete: (MediaFile) -> Unit,
    onSetProfile: (String) -> Unit,
) {
    // A single pending-delete target drives the confirmation dialog. Hoisted here
    // so the dialog floats above the whole grid rather than per-cell.
    var pendingDelete by remember { mutableStateOf<MediaFile?>(null) }
    // A1: tapping a tile opens it full-size (the cell's onClick was a dead {}).
    var pendingView by remember { mutableStateOf<MediaFile?>(null) }

    val glyphs = MediaCellGlyphs(
        play = Lucide.Play,
        document = Lucide.FileText,
        audio = Lucide.Music,
        broken = Lucide.Images,
        delete = Lucide.X,
        add = Lucide.Plus,
        profile = Lucide.Star,
    )

    AuntieMediaGrid(
        items = items,
        key = { it._id },
        modifier = Modifier.fillMaxWidth(),
    ) { item ->
        AuntieMediaCell(
            media = item,
            onClick = { pendingView = item },
            onDelete = { pendingDelete = item },
            // Only images can be a profile photo; non-images omit the action.
            onSetProfile = if (item.fileType.equals("IMAGE", ignoreCase = true)) {
                { onSetProfile(item._id) }
            } else null,
            showCaption = true,
            glyphs = glyphs,
            modifier = Modifier.fillMaxSize(),
        )
    }

    pendingDelete?.let { target ->
        DeleteMediaDialog(
            item = target,
            onConfirm = {
                onDelete(target)
                pendingDelete = null
            },
            onDismiss = { pendingDelete = null },
        )
    }

    pendingView?.let { target ->
        MediaViewerDialog(item = target, onDismiss = { pendingView = null })
    }
}

/**
 * A1: full-size media viewer. Tapping a tile opens this over the wasm-safe
 * AuntieDialog (Popup) — images render at full width, videos show their still
 * frame with a note. The filename shows beneath. Closes via the X or scrim.
 */
@Composable
private fun MediaViewerDialog(
    item: MediaFile,
    onDismiss: () -> Unit,
) {
    val c = AuntieTheme.colors
    val title = item.description.ifBlank { item.originalFileName }.ifBlank { "Media" }
    val url = item.storageUrl.ifBlank { item.thumbnailUrl }
    val isImageOrVideo = url.isNotBlank() &&
        (item.fileType.equals("IMAGE", ignoreCase = true) ||
            item.fileType.equals("VIDEO", ignoreCase = true))

    AuntieDialog(
        visible = true,
        title = title,
        onDismiss = onDismiss,
        closeIcon = Lucide.X,
        maxWidth = 900.dp,
    ) {
        if (isImageOrVideo) {
            AsyncImage(
                model = url,
                contentDescription = title,
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxWidth().heightIn(max = 600.dp),
            )
            if (item.fileType.equals("VIDEO", ignoreCase = true)) {
                Text(
                    text = "Video still frame. Open the file to play.",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
            }
        } else {
            Text(
                text = "No preview available for this file.",
                style = AuntieTheme.typography.bodyMedium,
                color = c.textDim,
            )
        }
        if (item.originalFileName.isNotBlank()) {
            Text(
                text = item.originalFileName,
                style = AuntieTheme.typography.bodySmall,
                color = c.textDim,
            )
        }
    }
}

/**
 * Delete confirmation. Copy verbatim from the shipped AlertDialog: title
 * "Delete Media", body "Are you sure you want to delete this {fileType lowercased}?",
 * buttons "Delete" / "Cancel".
 */
@Composable
private fun DeleteMediaDialog(
    item: MediaFile,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = AuntieTheme.colors
    AuntieDialog(
        visible = true,
        title = "Delete Media",
        onDismiss = onDismiss,
        maxWidth = 380.dp,
        closeIcon = Lucide.X,
        footer = {
            GhostButton(label = "Cancel", onClick = onDismiss)
            PrimaryButton(label = "Delete", onClick = onConfirm)
        },
    ) {
        Text(
            text = "Are you sure you want to delete this ${item.fileType.lowercase()}?",
            style = AuntieTheme.typography.bodyMedium,
            color = c.textDim,
        )
    }
}

private class FirestoreClientMediaDataSource(
    private val client: FirestoreClient,
) : AuntieDataSource {
    override fun invoicesStream() = client.invoicesStream()
    override fun kinfolkStream()  = client.kinfolkStream()
    override fun sessionsStream() = client.sessionsStream()
    override fun paymentsStream() = client.paymentsStream()
    override suspend fun recordPayment(payment: Payment) = client.recordPayment(payment)
    override fun businessSettingsStream() = client.businessSettingsStream()
    override suspend fun saveBusinessSettings(settings: BusinessSettings) = client.saveBusinessSettings(settings)
    override suspend fun approveBooking(bookingId: String) = client.approveBooking(bookingId)
    override suspend fun rejectBooking(bookingId: String)  = client.rejectBooking(bookingId)
    override suspend fun createBooking(booking: KinCareSession) = client.createBookingRequest(booking)
    override fun mediaStream(entityId: String, entityType: String) = client.mediaStream(entityId, entityType)
    override suspend fun uploadMedia(entityId: String, entityType: String, bytes: ByteArray, mimeType: String) =
        client.uploadMedia(entityId, entityType, bytes, mimeType)
    override suspend fun pickAndUploadMedia(entityId: String, entityType: String, max: Int) =
        client.pickAndUploadMedia(entityId, entityType, max)
    override suspend fun deleteMedia(mediaId: String, entityId: String) = client.deleteMedia(mediaId, entityId)
    override suspend fun setMediaProfilePhoto(mediaFileId: String, entityType: String, entityId: String) =
        client.setMediaProfilePhoto(mediaFileId, entityType, entityId)
    override fun reportForSessionStream(sessionId: String) = client.reportForSessionStream(sessionId)
    override suspend fun saveReport(report: KinCareReport) = client.saveReport(report)
    override suspend fun sendReport(report: com.tribetails.auntieos.web.data.KinCareReport, session: com.tribetails.auntieos.web.data.KinCareSession) = client.sendReport(report, session)
    override fun trainingDocsStream() = client.trainingDocsStream()
    override fun bookingNotesStream(kinfolkId: String, bookingId: String) =
        client.bookingNotesStream(kinfolkId, bookingId, internal = false)
    override fun bookingInternalNotesStream(kinfolkId: String, bookingId: String) =
        client.bookingNotesStream(kinfolkId, bookingId, internal = true)
    override suspend fun addBookingNote(kinfolkId: String, bookingId: String, body: String) =
        client.addBookingNote(kinfolkId, bookingId, body, internal = false)
    override suspend fun addInternalBookingNote(kinfolkId: String, bookingId: String, body: String) =
        client.addBookingNote(kinfolkId, bookingId, body, internal = true)
    override fun kinTaleCommentsStream(taleId: String, kinfolkId: String) =
        client.kinTaleCommentsStream(taleId, kinfolkId)
    override suspend fun addKinTaleComment(taleId: String, kinfolkId: String, body: String, parentCommentId: String?) =
        client.addKinTaleComment(taleId, kinfolkId, body, parentCommentId)
}
