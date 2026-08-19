package com.kinfolk.portal.screens.gallery

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinGhostButton
import com.kinfolk.portal.components.KinSpinner
import com.kinfolk.portal.components.KinfolkAvatar
import com.kinfolk.portal.components.KinfolkRemoteImage
import com.kinfolk.portal.portal.KinPhoto
import com.kinfolk.portal.portal.KinPortrait
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import com.kinfolk.portal.util.relativeDay

private const val GRID_COLUMNS = 3
private val TileCorner = 14.dp

/**
 * Every photo of a household's Kin, in one place (#469; the web portal's
 * `Gallery.tsx`, shipped in PR #436, is the other half of the same feature).
 *
 * This is the screen behind the Tribe hub's "All photos", which used to open
 * the KinTales feed because there was no gallery to open.
 *
 * Two kinds of picture, kept apart because they are not the same thing.
 * PORTRAITS are the one current photo per Kin, the same image the roster and
 * the Kin detail screen show, overwritten in place on every upload with no
 * history kept. PHOTOS are the archive: every image an Auntie has attached to
 * a KinTale, newest first, older ones read a page at a time.
 *
 * A video attached to a tale is drawn as a video, never as a photo tile that
 * happens to be blank. The play glyph on a tinted tile is the same convention
 * KinTalesScreen's thumbnail strip already uses.
 */
@Composable
fun GalleryScreen(
    kinfolkId: String,
    portalApi: PortalApi,
    onBack: () -> Unit,
    onOpenKinDetail: (String) -> Unit,
    onOpenKinTales: () -> Unit,
    controller: GalleryController = rememberGalleryController(kinfolkId, portalApi),
) {
    val type = LocalKinfolkTypography.current
    LaunchedEffect(kinfolkId) { if (controller.photos == null && controller.loadError == null) controller.reload() }

    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(KinfolkSpacing.s),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to your Tribe", tint = KinfolkBrand.Navy)
            }
            Spacer(Modifier.width(KinfolkSpacing.xs))
            Column {
                Text("The Gallery", style = type.heritageTitle)
                Text(
                    "Every picture we have of your Kin",
                    style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted),
                )
            }
        }

        Column(
            modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
            verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
        ) {
            if (controller.portraits.isNotEmpty()) {
                PortraitsCard(portraits = controller.portraits, onOpenKinDetail = onOpenKinDetail)
            }

            GlassCard(
                modifier = Modifier.fillMaxWidth(),
                contentPadding = PaddingValues(KinfolkSpacing.l),
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                    Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Text("From your KinTales", style = type.heritageSection)
                        Spacer(Modifier.weight(1f))
                        Text(
                            "All tales",
                            style = type.sansMeta.copy(color = KinfolkBrand.KinTeal),
                            modifier = Modifier
                                .clip(KinfolkShapes.pill)
                                .clickable { onOpenKinTales() }
                                .padding(horizontal = KinfolkSpacing.xs, vertical = 2.dp),
                        )
                    }

                    val photos = controller.photos
                    when {
                        controller.accessDenied -> Text(
                            "Your account doesn't have access to these photos. Message your Auntie if that looks wrong.",
                            style = type.sansBody.copy(color = KinfolkBrand.NavyMuted),
                        )
                        controller.loadError != null -> Text(
                            controller.loadError ?: "",
                            style = type.sansBody.copy(color = KinfolkBrand.SnuggleCoral),
                        )
                        photos == null -> Box(
                            modifier = Modifier.fillMaxWidth().padding(KinfolkSpacing.m),
                            contentAlignment = Alignment.Center,
                        ) { KinSpinner() }
                        photos.isEmpty() -> Text(
                            "No photos yet. Every KinTale your Auntie sends brings its pictures here.",
                            style = type.sansBody.copy(color = KinfolkBrand.NavyMuted),
                        )
                        else -> PhotoGrid(photos = photos, onOpen = { controller.openViewer(it) })
                    }

                    if (controller.moreError != null) {
                        Text(
                            controller.moreError ?: "",
                            style = type.sansMeta.copy(color = KinfolkBrand.SnuggleCoral),
                        )
                    }
                    if (controller.hasMore) {
                        KinGhostButton(
                            label = if (controller.loadingMore) "Loading..." else "Show older photos",
                            onClick = { controller.loadMore() },
                            enabled = !controller.loadingMore,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
        }
        Spacer(Modifier.height(KinfolkSpacing.l))
    }

    controller.viewing?.let { photo ->
        PhotoViewer(photo = photo, onClose = { controller.closeViewer() })
    }
}

@Composable
private fun PortraitsCard(portraits: List<KinPortrait>, onOpenKinDetail: (String) -> Unit) {
    val type = LocalKinfolkTypography.current
    GlassCard(
        modifier = Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            Text("Your Kin", style = type.heritageSection)
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
            ) {
                portraits.forEach { p ->
                    Column(
                        modifier = Modifier
                            .width(76.dp)
                            .clip(KinfolkShapes.cardSmall)
                            .clickable { onOpenKinDetail(p.kinId) }
                            .padding(KinfolkSpacing.xs),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs),
                    ) {
                        KinfolkAvatar(
                            url = p.url,
                            contentDescription = p.kinName.ifBlank { "Kin" },
                            size = 64.dp,
                        )
                        Text(
                            p.kinName.ifBlank { "Kin" },
                            style = type.sansMeta,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
        }
    }
}

/**
 * Three across, laid out row by row rather than through a lazy grid: this
 * screen already scrolls as one column, and a lazy grid nested in a scrolling
 * parent has no height to measure against.
 */
@Composable
private fun PhotoGrid(photos: List<KinPhoto>, onOpen: (KinPhoto) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
        photos.chunked(GRID_COLUMNS).forEach { row ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
            ) {
                row.forEach { photo ->
                    Box(modifier = Modifier.weight(1f)) { PhotoTile(photo = photo, onOpen = onOpen) }
                }
                // Keeps a short last row's tiles the same width as a full
                // row's, instead of stretching two photos across three slots.
                repeat(GRID_COLUMNS - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

@Composable
private fun PhotoTile(photo: KinPhoto, onOpen: (KinPhoto) -> Unit) {
    val type = LocalKinfolkTypography.current
    Column(
        modifier = Modifier
            .testTag("galleryTile")
            .fillMaxWidth()
            .clip(RoundedCornerShape(TileCorner))
            .clickable { onOpen(photo) },
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Box(
            modifier = Modifier.fillMaxWidth().aspectRatio(1f),
            contentAlignment = Alignment.Center,
        ) {
            if (photo.isImage()) {
                KinfolkRemoteImage(
                    url = photo.url,
                    contentDescription = photoCaption(photo),
                    modifier = Modifier.fillMaxSize(),
                    cornerRadius = TileCorner,
                )
            } else {
                // No poster frame is available for a video, and an image
                // request pointed at an mp4 draws a broken-image glyph, which
                // reads as a photo that failed rather than as a clip.
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .clip(RoundedCornerShape(TileCorner))
                        .background(KinfolkBrand.GlassSurfaceDim),
                    contentAlignment = Alignment.Center,
                ) {
                    Text("▶️", fontSize = 22.sp)
                }
            }
        }
        Text(
            photoCaption(photo),
            style = type.sansMeta,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * One photo, full width, with what it came from underneath it.
 *
 * The tile is small enough that a household cannot actually see the picture in
 * it, which is the whole reason the archive is worth having.
 */
@Composable
private fun PhotoViewer(photo: KinPhoto, onClose: () -> Unit) {
    val type = LocalKinfolkTypography.current
    Dialog(onDismissRequest = onClose) {
        GlassCard(
            modifier = Modifier.fillMaxWidth(),
            contentPadding = PaddingValues(KinfolkSpacing.m),
        ) {
            Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        photoCaption(photo),
                        style = type.heritageSection,
                        modifier = Modifier.weight(1f),
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    IconButton(onClick = onClose) {
                        Icon(Icons.Filled.Close, contentDescription = "Close photo", tint = KinfolkBrand.Navy)
                    }
                }
                if (photo.isImage()) {
                    KinfolkRemoteImage(
                        url = photo.url,
                        contentDescription = photoCaption(photo),
                        modifier = Modifier.fillMaxWidth().aspectRatio(1f),
                    )
                } else {
                    Text(
                        "This one is a video. Open its KinTale to play it.",
                        style = type.sansBody.copy(color = KinfolkBrand.NavyMuted),
                        textAlign = TextAlign.Start,
                    )
                }
                photo.takenAtMs?.let {
                    Text(relativeDay(it), style = type.sansMeta.copy(color = KinfolkBrand.NavyMuted))
                }
            }
        }
    }
}

/**
 * What a tile says under itself: the KinTale's title, or when the tale has no
 * title, the day it arrived. Same fallback the web Gallery uses.
 */
private fun photoCaption(photo: KinPhoto): String =
    photo.taleTitle.ifBlank { photo.takenAtMs?.let { relativeDay(it) } ?: "A KinTale" }
