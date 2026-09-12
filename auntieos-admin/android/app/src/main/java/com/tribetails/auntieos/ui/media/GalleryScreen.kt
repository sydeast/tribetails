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
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.viewmodel.compose.viewModel
import coil3.compose.AsyncImage
import coil3.request.ImageRequest
import coil3.request.crossfade
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.FileText
import com.composables.icons.lucide.ImageOff
import com.composables.icons.lucide.Images
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.Music
import com.composables.icons.lucide.Play
import com.composables.icons.lucide.X
import com.tribetails.auntieos.data.model.BUSINESS_ENTITY_ID
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.MediaEntityType
import com.tribetails.auntieos.data.model.MediaFile
import com.tribetails.auntieos.data.model.MediaType
import com.tribetails.auntieos.domain.GalleryFilter
import com.tribetails.auntieos.domain.filterGalleryMedia
import com.tribetails.auntieos.domain.galleryFileTypes
import com.tribetails.auntieos.domain.galleryHasUnattachedMedia
import com.tribetails.auntieos.domain.galleryKinfolkIds
import com.tribetails.auntieos.domain.galleryMonths
import com.tribetails.auntieos.domain.taggableKin
import com.tribetails.auntieos.domain.taggedKinNames
import com.tribetails.auntieos.ui.components.AuntieBanner
import com.tribetails.auntieos.ui.components.AuntieBannerTone
import com.tribetails.auntieos.ui.components.AuntieCard
import com.tribetails.auntieos.ui.components.AuntieEmptyState
import com.tribetails.auntieos.ui.components.AuntieIconButton
import com.tribetails.auntieos.ui.components.AuntieMediaCell
import com.tribetails.auntieos.ui.components.AuntieModal
import com.tribetails.auntieos.ui.components.AuntieScreenScaffold
import com.tribetails.auntieos.ui.components.AuntieSelectField
import com.tribetails.auntieos.ui.components.AuntieStatusPill
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.ui.components.DenScreenHeading
import com.tribetails.auntieos.ui.components.EmptyHint
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.components.LoadingHint
import com.tribetails.auntieos.ui.components.MediaCellGlyphs
import com.tribetails.auntieos.ui.components.PrimaryButton
import com.tribetails.auntieos.ui.components.SegmentedPicker
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * #13 global Gallery (android): all business media across every KinTale/entity in one
 * place, filterable by household / type / month, with per-image kin tagging and,
 * since #755, delete. Mirrors the web `Gallery.tsx`; the two move together.
 *
 * THE MOCK (#755, the glass sweep) is `ui-ideas/auntieos-media-gallery-2026-05-27.html`.
 * It mirrors the entity-scoped MediaGalleryScreen, and this global screen takes
 * the same skin: the kit hero with the count chip and the upload action in its
 * trailing slot, ONE type row with per-type counts as the mock's segmented
 * tray (cream on navy), household and month as compact selects beside it (the
 * two facets the mock's entity-scoped screen never had, so they stay small), a
 * 120dp adaptive grid of the kit's square media cell (play badge, duration,
 * document and audio drawn as glyph plus file name), the profile marker as the
 * compact teal status pill, the mock's top-end delete X on every tile with its
 * confirm copy, and the mock's empty block with its two lines of copy. It was
 * a plain top bar over a sentence of explanation, a full-width upload button,
 * three labelled chip rows in brand orange, and a 110dp grid of bare
 * thumbnails.
 *
 * The explanation the old screen printed under the title is the heading's
 * tooltip now (#758): explanatory copy is never a line on the screen.
 *
 * The mock's back arrow belongs to its entity-scoped screen; this is a
 * bottom-nav destination and the scaffold's own back is all it needs.
 */
@Composable
fun GalleryScreen(
    viewModel: GalleryViewModel = viewModel(),
    uploadViewModel: MediaUploadViewModel = viewModel(),
    onBack: () -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    // #3 (2026-06-08): upload from the gallery. Pick a household or Company, then
    // the system media picker opens (MediaPickerDialog); a household stamps its
    // kinfolkId so kin-tagging scopes correctly, Company leaves kinfolkId absent
    // (operator ruling 2026-07-31: Kinfolk do not "own" media, there is company
    // media and other uploads unrelated to any kinfolk/kin).
    var showTargetPicker by remember { mutableStateOf(false) }
    var uploadTarget by remember { mutableStateOf<UploadTarget?>(null) }

    AuntieScreenScaffold(title = "Gallery", onBack = onBack) {
        GalleryBody(viewModel = viewModel, onUpload = { showTargetPicker = true })
    }

    // #3 / operator ruling 2026-07-31: choose which household this upload belongs
    // to, or Company for media unrelated to any household. Company is always
    // listed first and is always selectable, even with zero households on file
    // (kinfolk do not "own" media, so Upload is never blocked on the roster).
    if (showTargetPicker) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { showTargetPicker = false },
            confirmButton = {},
            title = { Text("Where should this upload go?") },
            text = {
                androidx.compose.foundation.lazy.LazyColumn(
                    modifier = Modifier.heightIn(max = 360.dp),
                ) {
                    item {
                        Text(
                            text = "Company (no household)",
                            style = AuntieTheme.typography.bodyLarge,
                            color = AuntieTheme.colors.textPrimary,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { showTargetPicker = false; uploadTarget = UploadTarget.Company }
                                .padding(vertical = 12.dp),
                        )
                    }
                    items(state.kinfolk.size) { i ->
                        val kf = state.kinfolk[i]
                        Text(
                            text = kf.displayName,
                            style = AuntieTheme.typography.bodyLarge,
                            color = AuntieTheme.colors.textPrimary,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { showTargetPicker = false; uploadTarget = UploadTarget.Household(kf) }
                                .padding(vertical = 12.dp),
                        )
                    }
                }
            },
        )
    }

    // #3: once a target is chosen, the system media picker + upload runs. A
    // household stamps kinfolkId (entityId is the kinfolkId); Company (BUSINESS)
    // leaves it absent (operator ruling 2026-07-31).
    uploadTarget?.let { target ->
        MediaPickerDialog(
            entityId = target.entityId,
            entityType = target.entityType,
            entityName = target.entityName,
            onDismiss = { uploadTarget = null },
            onMediaUploaded = { uploadTarget = null; viewModel.load() },
            viewModel = uploadViewModel,
        )
    }
}

/** The mock's `.pills`: "All 10", "Images 5", the count riding after the word. */
internal fun galleryTypePillLabel(type: MediaType?, count: Int): String {
    val word = when (type) {
        null -> "All"
        MediaType.IMAGE -> "Images"
        MediaType.VIDEO -> "Videos"
        MediaType.DOCUMENT -> "Documents"
        MediaType.AUDIO -> "Audio"
    }
    return "$word $count"
}

/**
 * The word the confirm names: the mock's `{fileType lowercased}`, which is also
 * what MediaGalleryScreen's own confirm prints. "audio file" rather than
 * "audio", so the sentence still reads as one thing being deleted.
 */
internal fun galleryDeleteKindWord(type: MediaType): String = when (type) {
    MediaType.IMAGE -> "image"
    MediaType.VIDEO -> "video"
    MediaType.DOCUMENT -> "document"
    MediaType.AUDIO -> "audio file"
}

/** The value of the household select for "every household"; distinct from "" (no household). */
private const val HOUSEHOLD_ANY = " any"
private const val MONTH_ANY = " any"

/**
 * The screen under the scaffold. Split from [GalleryScreen] so a Robolectric
 * test can hand it a [GalleryViewModel] over a mocked repository without the
 * upload view model or the navigation host (the InvitesBody precedent).
 */
@Composable
fun GalleryBody(
    viewModel: GalleryViewModel,
    onUpload: () -> Unit,
) {
    val c = AuntieTheme.colors
    val state by viewModel.uiState.collectAsState()
    var selected by remember { mutableStateOf<MediaFile?>(null) }
    // A1 (A8): tapping a tile opens a full-size viewer (was: jumped straight to tagging).
    var pendingView by remember { mutableStateOf<MediaFile?>(null) }
    // #755. The row whose delete confirm is open. The ROW, not an id, so the
    // dialog can name the file type the way the mock's body copy does.
    var pendingDelete by remember { mutableStateOf<MediaFile?>(null) }

    LaunchedEffect(Unit) { viewModel.load() }

    val shown = filterGalleryMedia(state.media, state.filter)
    val months = galleryMonths(state.media)
    val types = galleryFileTypes(state.media)
    val kinfolkIds = galleryKinfolkIds(state.media)
    val hasUnattachedMedia = galleryHasUnattachedMedia(state.media)
    val kinfolkLabel = state.kinfolk.associate { it.id to it.lastName.ifBlank { it.id.take(6) } }
    val kinById = state.kin.associateBy { it.id }
    // Per-type counts for the tray, counted over the WHOLE read and never the
    // filtered slice: narrowing to Videos must not restate Images as 0.
    val countByType = state.media.groupingBy { it.fileType }.eachCount()

    Column(modifier = Modifier.fillMaxSize().padding(16.dp)) {
        DenScreenHeading(
            kicker = "The Den · Gallery",
            title = "All",
            accentTail = "media",
            subtitle = "All media from every KinTale, tagged to its household. Tap a photo to tag the kin in it.",
            trailing = {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    // The mock's `.count`, gated the same way MediaGalleryScreen
                    // gates it: never a number nobody has read.
                    mediaCountChipLabel(
                        isLoading = state.isLoading,
                        error = state.error,
                        count = state.media.size,
                    )?.let { MediaCountChip(label = it) }
                    PrimaryButton(label = "Upload media", onClick = onUpload)
                }
            },
        )
        Spacer(Modifier.height(16.dp))

        // A refused delete. Above the grid, never in place of it: the rows are
        // exactly what the operator needs to see to understand the refusal.
        state.actionError?.let { message ->
            AuntieBanner(
                tone = AuntieBannerTone.Error,
                title = "That did not go through",
                dismissible = true,
                onDismiss = { viewModel.clearActionError() },
            ) {
                Text(message, style = AuntieTheme.typography.bodySmall, color = c.textPrimary)
            }
            Spacer(Modifier.height(12.dp))
        }

        // Controls only over a read that produced rows: a tray of counts beside
        // an empty block would be five zeros.
        if (!state.isLoading && state.error == null && state.media.isNotEmpty()) {
            GalleryControls(
                filter = state.filter,
                types = types,
                countByType = countByType,
                total = state.media.size,
                kinfolkIds = kinfolkIds,
                hasUnattachedMedia = hasUnattachedMedia,
                kinfolkLabel = kinfolkLabel,
                months = months,
                onFilter = { viewModel.setFilter(it) },
            )
            Spacer(Modifier.height(12.dp))
        }

        when {
            state.isLoading -> LoadingHint("Loading media…")
            // Never the empty block during a failure: "no media" and "could not
            // find out" are opposite facts.
            state.error != null -> EmptyHint(state.error!!, error = true)
            state.media.isEmpty() -> AuntieEmptyState(
                title = "No media files found",
                message = "Upload photos and videos to see them here",
                icon = Lucide.Images,
            )
            shown.isEmpty() -> EmptyHint("No media matches these filters.")
            else -> {
                Text("${shown.size} of ${state.media.size}", style = AuntieTheme.typography.labelSmall, color = c.textFaint)
                Spacer(Modifier.height(8.dp))
                // The mock's grid: GridCells.Adaptive(120.dp), square cells, 12dp gaps.
                LazyVerticalGrid(
                    columns = GridCells.Adaptive(120.dp),
                    modifier = Modifier.fillMaxSize().weight(1f),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    items(shown, key = { it.id }) { media ->
                        GalleryTile(
                            media = media,
                            taggedNames = taggedKinNames(media, kinById),
                            onOpen = { pendingView = media },
                            onDelete = { pendingDelete = media },
                        )
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

    // The mock's confirm, verbatim: "Delete Media" / "Are you sure you want to
    // delete this {fileType lowercased}?" / Delete / Cancel. Web and the
    // entity-scoped screen print the same three lines.
    pendingDelete?.let { media ->
        AuntieModal(
            onDismissRequest = { pendingDelete = null },
            title = "Delete Media",
            confirmButton = {
                PrimaryButton(
                    label = "Delete",
                    onClick = {
                        // The dialog closes on the click; the outcome lands in
                        // state (the row goes, or the banner says why not).
                        viewModel.deleteMedia(media.id) {}
                        pendingDelete = null
                    },
                )
            },
            dismissButton = {
                GhostButton(label = "Cancel", onClick = { pendingDelete = null })
            },
        ) {
            Column {
                Text(
                    "Are you sure you want to delete this ${galleryDeleteKindWord(media.fileType)}?",
                    style = AuntieTheme.typography.bodyMedium,
                    color = c.textPrimary,
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    "This removes it from the gallery and cannot be undone.",
                    style = AuntieTheme.typography.bodySmall,
                    color = c.textDim,
                )
                if (media.isProfilePhoto) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "This is a profile photo. Deleting it leaves its owner without one until another is chosen.",
                        style = AuntieTheme.typography.bodySmall,
                        color = c.textDim,
                    )
                }
            }
        }
    }
}

/**
 * ONE control row (#755), the way the mock draws it: the type tray on the
 * leading edge with its counts, cream on navy for the selected segment, and
 * the two facets the mock's entity-scoped screen never had (household, month)
 * as compact selects under it. They were three labelled chip rows in brand
 * orange, which pushed the grid a third of the way down the screen.
 */
@Composable
private fun GalleryControls(
    filter: GalleryFilter,
    types: List<MediaType>,
    countByType: Map<MediaType, Int>,
    total: Int,
    kinfolkIds: List<String>,
    hasUnattachedMedia: Boolean,
    kinfolkLabel: Map<String, String>,
    months: List<String>,
    onFilter: (GalleryFilter) -> Unit,
) {
    if (types.isNotEmpty()) {
        // The tray is a fixed-height row with no wrapping of its own, and five
        // segments with counts do not fit a phone, so it scrolls sideways.
        Row(modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            SegmentedPicker(
                options = listOf<MediaType?>(null) + types,
                selected = filter.fileType,
                onSelect = { onFilter(filter.copy(fileType = it)) },
                label = { galleryTypePillLabel(it, if (it == null) total else countByType[it] ?: 0) },
            )
        }
        Spacer(Modifier.height(10.dp))
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
        if (kinfolkIds.isNotEmpty() || hasUnattachedMedia) {
            // `""` is a REAL filter value (media with no household at all), so
            // "no filter" cannot also be the empty string; it is HOUSEHOLD_ANY.
            val options = listOf(HOUSEHOLD_ANY) + (if (hasUnattachedMedia) listOf("") else emptyList()) + kinfolkIds
            AuntieSelectField(
                label = "",
                options = options,
                selected = filter.kinfolkId ?: HOUSEHOLD_ANY,
                onSelect = { onFilter(filter.copy(kinfolkId = if (it == HOUSEHOLD_ANY) null else it)) },
                optionLabel = { id ->
                    when (id) {
                        HOUSEHOLD_ANY -> "All households"
                        "" -> "No household"
                        else -> kinfolkLabel[id] ?: "Unknown household"
                    }
                },
                modifier = Modifier.weight(1f),
            )
        }
        if (months.isNotEmpty()) {
            AuntieSelectField(
                label = "",
                options = listOf(MONTH_ANY) + months,
                selected = filter.monthPrefix ?: MONTH_ANY,
                onSelect = { onFilter(filter.copy(monthPrefix = if (it == MONTH_ANY) null else it)) },
                optionLabel = { if (it == MONTH_ANY) "All months" else it },
                modifier = Modifier.weight(1f),
            )
        }
    }
}

/** The kit cell's glyphs, chosen once: the mock's play triangle, FileText, Music, a slashed image for a dead thumbnail. */
private val GALLERY_CELL_GLYPHS = MediaCellGlyphs(
    play = Lucide.Play,
    document = Lucide.FileText,
    audio = Lucide.Music,
    broken = Lucide.ImageOff,
)

/**
 * The Gallery upload dialog's target: a household (KINFOLK, kinfolkId stamped
 * from its id), or Company (BUSINESS, the fixed [BUSINESS_ENTITY_ID], kinfolkId
 * left absent by `saveMediaFile`). Operator ruling 2026-07-31: Kinfolk do not
 * "own" media, so Company is always offered, even with zero households on file.
 */
private sealed class UploadTarget {
    abstract val entityId: String
    abstract val entityType: MediaEntityType
    abstract val entityName: String

    data class Household(val kinfolk: Kinfolk) : UploadTarget() {
        override val entityId get() = kinfolk.id
        override val entityType get() = MediaEntityType.KINFOLK
        override val entityName get() = kinfolk.displayName
    }

    object Company : UploadTarget() {
        override val entityId = BUSINESS_ENTITY_ID
        override val entityType = MediaEntityType.BUSINESS
        override val entityName = "Company"
    }
}


/**
 * A1 (A8): full-size media viewer. Tapping a tile opens this (instead of jumping
 * straight to tag-editing). Images render full-res; for video we show the poster and
 * say so plainly rather than faking inline playback. "Tag kin" hands off to the tag
 * dialog so tagging is still one tap away.
 *
 * #691, "cannot view the entire photo". This was a platform-default-width dialog
 * whose stage was capped at 420.dp, so a 1080px photo was shown at roughly a third
 * of its size with no way to see the rest of it: the SAME defect the web viewer
 * had, on the same global-gallery screen. It now takes the whole window
 * (usePlatformDefaultWidth = false) and the stage takes whatever height the rest
 * of the column leaves, with ContentScale.Fit still showing the whole frame.
 * "Open original" hands the file to the browser at its own resolution, which is
 * this platform's answer to the web viewer's fullscreen toggle: an Android dialog
 * that fills the window IS the fullscreen state.
 *
 * MediaGalleryScreen.kt's `FullscreenMediaViewer` (the entity-scoped screen's
 * viewer) never had this defect: it has always been usePlatformDefaultWidth =
 * false plus fillMaxSize. It is deliberately left alone.
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
    val uriHandler = LocalUriHandler.current
    Dialog(
        onDismissRequest = onDismiss,
        properties       = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .clip(RoundedCornerShape(16.dp))
                .background(c.surface)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            val isVisual = media.fileType == MediaType.IMAGE || media.fileType == MediaType.VIDEO
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
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
                        modifier = Modifier.fillMaxSize(),
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
                    "Video preview. Open the source to play.",
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
            // #691. The way out to the file itself, at its own resolution, in a
            // browser that can zoom and save. Offered only when there IS a stored
            // original: a thumbnail is not the original, and a button that opened
            // a 300px crop labelled "Open original" would be a lie.
            if (media.storageUrl.isNotBlank()) {
                GhostButton(
                    label = "Open original",
                    onClick = { uriHandler.openUri(media.storageUrl) },
                    modifier = Modifier.fillMaxWidth(),
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

/**
 * #593. True when the asynchronous video location-metadata strip ran out of
 * attempts without succeeding, so the stored video still holds the coordinates
 * the camera wrote.
 *
 * Mirrors the web admin's `mediaGpsStripState` in `lib/mediaFormat.ts`, and
 * coerces the same way: the field is FREE TEXT off Firestore, absent on every
 * image (a photo is stripped before Cloudinary stores it, #583, so there is no
 * async step) and absent on every video predating #593. Anything it does not
 * recognise is NOT reported as failed and equally NOT reported as clean -- the
 * badge only ever makes the one claim it can back up.
 *
 * Internal rather than private so the rule is unit-testable without composing
 * the screen.
 */
internal fun mediaGpsStripFailed(media: MediaFile): Boolean =
    media.gpsStripStatus.trim().uppercase() == "FAILED"


/**
 * One grid cell (#755). The kit's [AuntieMediaCell] draws the tile itself
 * (thumbnail, the mock's play badge and duration on a video, glyph plus file
 * name on a document or audio file, the slashed glyph on a dead thumbnail, the
 * hover lift), and this lays the global gallery's own marks over it:
 *
 *  - the profile marker, the mock's `.pf`, as the compact teal status pill;
 *  - #593's "Location not removed" badge, one row under it;
 *  - who is tagged (#447), bottom start, so the grid answers "which photos
 *    have Waddles in them" without opening every one;
 *  - the mock's top-end delete X. ALWAYS painted: the kit cell reveals its
 *    own on hover, and a phone has no hover, so an action only a pointer can
 *    summon is the same as no action.
 *
 * The delete disc is not inside the cell's clickable, so a tap on it never
 * also opens the viewer.
 */
@Composable
private fun GalleryTile(
    media: MediaFile,
    taggedNames: List<String>,
    onOpen: () -> Unit,
    onDelete: () -> Unit,
) {
    val c = AuntieTheme.colors
    val caption = media.description.ifBlank { media.originalFileName }.ifBlank { "Media" }
    val stripFailed = mediaGpsStripFailed(media)
    Box(modifier = Modifier.fillMaxWidth().aspectRatio(1f)) {
        AuntieMediaCell(
            media = media,
            onClick = onOpen,
            glyphs = GALLERY_CELL_GLYPHS,
            modifier = Modifier.fillMaxSize(),
        )
        if (media.isProfilePhoto) {
            AuntieStatusPill(
                label = "Profile",
                tone = AuntieStatusTone.Teal,
                mono = true,
                compact = true,
                modifier = Modifier.align(Alignment.TopStart).padding(8.dp),
            )
        }
        // #593. Only the FAILED state is drawn. PENDING is ordinary progress
        // measured in seconds, and badging it would put an alarming label on
        // every video the moment it lands; STRIPPED is the expected outcome.
        // FAILED means the video still carries the coordinates it was
        // recorded with and no further retry is coming, which is the one
        // state an operator has to see without reading a log. One row under
        // the profile marker, since either can be true on its own.
        if (stripFailed) {
            Box(
                modifier = Modifier
                    .align(Alignment.TopStart)
                    .padding(start = 8.dp, top = if (media.isProfilePhoto) 34.dp else 8.dp, end = 40.dp)
                    .clip(RoundedCornerShape(999.dp))
                    .background(c.error.copy(alpha = 0.92f))
                    .padding(horizontal = 7.dp, vertical = 2.dp),
            ) {
                Text(
                    text = "Location not removed",
                    style = AuntieTheme.typography.labelSmall,
                    color = c.background,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (taggedNames.isNotEmpty()) {
            // The mock's caption-strip tint, brand navy at half, not solid orange.
            Box(
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .padding(8.dp)
                    .clip(RoundedCornerShape(999.dp))
                    .background(c.background.copy(alpha = 0.5f))
                    .padding(horizontal = 7.dp, vertical = 2.dp),
            ) {
                Text(
                    text = if (taggedNames.size == 1) taggedNames.first() else "${taggedNames.size} kin",
                    style = AuntieTheme.typography.labelSmall,
                    color = c.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        // The mock's `.del`: a 26dp disc of navy at 80% on a hairline.
        Box(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(8.dp)
                .clip(RoundedCornerShape(999.dp))
                .background(c.background.copy(alpha = 0.8f))
                .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(999.dp)),
        ) {
            AuntieIconButton(
                icon = Lucide.X,
                contentDescription = "Delete $caption",
                onClick = onDelete,
                size = 26.dp,
                destructive = true,
            )
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
