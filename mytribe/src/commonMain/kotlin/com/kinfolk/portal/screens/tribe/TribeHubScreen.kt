package com.kinfolk.portal.screens.tribe

import com.kinfolk.portal.util.formatPhone
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinSpinner
import com.kinfolk.portal.components.KinfolkAvatar
import com.kinfolk.portal.components.KinfolkRemoteImage
import com.kinfolk.portal.components.ScreenHeader
import com.kinfolk.portal.portal.Kin
import com.kinfolk.portal.portal.KinPhotosResult
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.TribeProfileResult
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import kotlin.coroutines.cancellation.CancellationException

/**
 * #1463: the Gallery card reads the same first page the Gallery screen reads
 * (GALLERY_PAGE_SIZE). `limit` counts KinTales, not pictures, so a smaller page
 * could come back with no photos for a household that has plenty, and the card
 * would wrongly say there are none. The card draws at most
 * [GALLERY_CARD_THUMBS] of what comes back. Same numbers as portal web's
 * `TribeHub.tsx`.
 */
internal const val GALLERY_CARD_PAGE = 12
internal const val GALLERY_CARD_THUMBS = 8

/** One thumbnail on the Tribe page's Gallery card. */
internal data class GalleryCardThumb(val key: String, val url: String, val label: String, val isImage: Boolean)

/**
 * Newest KinTale media first, then the Kin portraits, capped at
 * [GALLERY_CARD_THUMBS]. The same order portal web's Gallery card uses.
 */
internal fun galleryCardThumbs(page: KinPhotosResult): List<GalleryCardThumb> =
    (
        page.photos.map { GalleryCardThumb("p-${it.id}", it.url, it.taleTitle.ifBlank { "A KinTale" }, it.isImage()) } +
            page.portraits.map { GalleryCardThumb("k-${it.kinId}", it.url, it.kinName, isImage = true) }
        ).take(GALLERY_CARD_THUMBS)

/**
 * The Tribe tab as a family-base HUB (per smoke-test): Kin profile cards, the
 * Gallery card and a Home info summary, with profile editing behind the avatar
 * menu's Edit Tribe Profile entry and the Home Information card's Edit link
 * (#1454, no page-level button). Read-only surface; every section links out to
 * its dedicated screen.
 *
 * #1463 (operator, 2026-11-02): "KinTales have media taken for the visit. but
 * Gallery is the collection of all media over time." The Gallery card is always
 * drawn and shows the newest KinTale media plus the Kin portraits from
 * `getMyKinPhotos`, not just the roster's faces. The KinTales section that used
 * to sit here is gone; it repeated the Tales tab.
 */
@Composable
fun TribeHubScreen(
    familyName: String,
    kinfolkId: String,
    portalApi: PortalApi,
    onEditProfile: () -> Unit,
    onOpenKinDetail: (String) -> Unit,
    onManageKin: () -> Unit,
    onOpenGallery: () -> Unit,
) {
    val type = LocalKinfolkTypography.current
    var kin by remember { mutableStateOf<List<Kin>?>(null) }
    var kinFailed by remember { mutableStateOf(false) }
    var media by remember { mutableStateOf<KinPhotosResult?>(null) }
    var mediaFailed by remember { mutableStateOf(false) }
    var profile by remember { mutableStateOf<TribeProfileResult?>(null) }

    LaunchedEffect(kinfolkId) {
        try { kin = portalApi.getMyKin(kinfolkId).kin; kinFailed = false } catch (c: CancellationException) { throw c } catch (_: Throwable) { kinFailed = true }
    }
    LaunchedEffect(kinfolkId) {
        try {
            media = portalApi.getMyKinPhotos(kinfolkId = kinfolkId, limit = GALLERY_CARD_PAGE)
            mediaFailed = false
        } catch (c: CancellationException) { throw c } catch (_: Throwable) { mediaFailed = true }
    }
    LaunchedEffect(kinfolkId) {
        try { profile = portalApi.getMyTribeProfile(kinfolkId) } catch (c: CancellationException) { throw c } catch (_: Throwable) { /* home info card hides */ }
    }

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
    ) {
        ScreenHeader(
            title = familyName.ifBlank { "Your family base" },
            kicker = "Your family base",
        )
        // #1454 (operator ruling on #1295): no Edit Tribe Profile button on the
        // page. On Android the account menu's entry (TabRoute.kt accountMenu) is
        // the only one; the Home Information card keeps its own "Edit" link.

        // ---- Kin profile cards ----
        SectionCard(title = "Your Kin", linkText = "Manage", onLink = onManageKin) {
            when {
                kinFailed -> Text("Couldn't load your Kin right now.", style = type.sansBody.copy(color = KinfolkBrand.NavyMuted))
                kin == null -> Box(Modifier.fillMaxWidth().padding(KinfolkSpacing.m), contentAlignment = Alignment.Center) { KinSpinner() }
                kin!!.isEmpty() -> Text("No Kin yet. Add your pets from Manage.", style = type.sansBody.copy(color = KinfolkBrand.NavyMuted))
                else -> LazyRow(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.m)) {
                    items(kin!!) { k -> KinTile(k, onOpenKinDetail) }
                }
            }
        }

        // ---- Gallery: the household's media over time (#1463), always drawn ----
        SectionCard(title = "Gallery", linkText = "All photos", onLink = onOpenGallery) {
            val page = media
            val thumbs = page?.let { galleryCardThumbs(it) }.orEmpty()
            when {
                mediaFailed -> Text("Photos unavailable right now.", style = type.sansBody.copy(color = KinfolkBrand.NavyMuted))
                page == null -> Box(Modifier.fillMaxWidth().padding(KinfolkSpacing.m).testTag("tribeGalleryLoading"), contentAlignment = Alignment.Center) { KinSpinner() }
                // The page counts KinTales, so a household whose newest tales
                // carry no pictures can still have older ones behind it.
                thumbs.isEmpty() -> Text(
                    if (page.hasMore) "No recent photos. Older ones are in All photos." else "No photos yet.",
                    style = type.sansBody.copy(color = KinfolkBrand.NavyMuted),
                )
                else -> LazyRow(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                    items(thumbs, key = { it.key }) { t -> GalleryThumb(t) }
                }
            }
        }

        // ---- Home info summary (read-only; edit via the profile editor) ----
        val p = profile
        if (p != null) {
            SectionCard(title = "Home Information", linkText = "Edit", onLink = onEditProfile) {
                val facts = buildList {
                    p.homeAccess.gateCode?.takeIf { it.isNotBlank() }?.let { add("Gate / door code on file") }
                    p.homeAccess.keyLocation?.takeIf { it.isNotBlank() }?.let { add("Key location on file") }
                    p.homeAccess.wifiPassword?.takeIf { it.isNotBlank() }?.let { add("Wi-Fi on file") }
                    vetFact(p)?.let { add(it) }
                }
                if (facts.isEmpty()) {
                    Text("No home details yet. Add gate codes, key location, and your vet.", style = type.sansBody.copy(color = KinfolkBrand.NavyMuted))
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs)) {
                        facts.forEach { Text("• $it", style = type.sansBody) }
                    }
                }
            }
        }
        Spacer(Modifier.height(KinfolkSpacing.l))
    }
}

@Composable
private fun SectionCard(
    title: String,
    linkText: String? = null,
    onLink: () -> Unit = {},
    content: @Composable () -> Unit,
) {
    val type = LocalKinfolkTypography.current
    GlassCard(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        contentPadding = PaddingValues(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(title, style = type.heritageSection)
                Spacer(Modifier.weight(1f))
                if (linkText != null) {
                    Text(
                        linkText,
                        style = type.sansMeta.copy(color = KinfolkBrand.KinTeal),
                        modifier = Modifier.clip(KinfolkShapes.pill).clickable { onLink() }.padding(horizontal = KinfolkSpacing.xs, vertical = 2.dp),
                    )
                }
            }
            content()
        }
    }
}

@Composable
private fun KinTile(kin: Kin, onOpen: (String) -> Unit) {
    val type = LocalKinfolkTypography.current
    val name = kin.name?.takeIf { it.isNotBlank() } ?: "Kin"
    Column(
        modifier = Modifier
            .width(84.dp)
            .clip(KinfolkShapes.cardSmall)
            .clickable { onOpen(kin.id) }
            .padding(KinfolkSpacing.xs),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs),
    ) {
        val photo = kin.photoUrl
        if (!photo.isNullOrBlank()) {
            KinfolkAvatar(url = photo, contentDescription = name, size = 64.dp)
        } else {
            Box(
                modifier = Modifier.size(64.dp).clip(CircleShape).border(2.dp, KinfolkBrand.KinfolkOrange, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Text(name.take(1).uppercase(), style = type.heritageTitle.copy(color = KinfolkBrand.KinfolkOrange))
            }
        }
        Text(name, style = type.sansMeta, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/**
 * A 64dp square, the same size as portal web's `.gallery-thumb`. A video is
 * drawn as a play glyph, the same as the Gallery screen's tiles: an image
 * request pointed at an mp4 draws a broken picture.
 */
@Composable
private fun GalleryThumb(thumb: GalleryCardThumb) {
    val shape = KinfolkShapes.cardSmall
    if (thumb.isImage) {
        KinfolkRemoteImage(
            url = thumb.url,
            contentDescription = thumb.label,
            modifier = Modifier.size(64.dp).testTag("tribeGalleryThumb"),
            cornerRadius = 16.dp,
        )
    } else {
        Box(
            modifier = Modifier
                .size(64.dp)
                .clip(shape)
                .background(KinfolkBrand.GlassSurfaceDim)
                .testTag("tribeGalleryThumb")
                .semantics { contentDescription = thumb.label },
            contentAlignment = Alignment.Center,
        ) {
            Text("▶️", fontSize = 22.sp)
        }
    }
}

/**
 * #1325: the Vet line on the Tribe page. The clinic the household picked, by name,
 * address and formatted phone, as the server resolved it from `vetClinicId`; the
 * old `vetClinicName` row (saved before the picker) is only the fallback and
 * never wins over a pick. Never the database id. The twin of the Vet fact in
 * portal web's `TribeHub.tsx`.
 */
internal fun vetFact(p: TribeProfileResult): String? {
    val vet = p.vetClinic
    if (vet != null) {
        return "Vet: " + listOf(vet.name, vet.address, formatPhone(vet.phone)).filter { it.isNotBlank() }.joinToString(" · ")
    }
    return p.profile.customFields.firstOrNull { it.key == "vetClinicName" && it.value.isNotBlank() }?.let { "Vet: ${it.value}" }
}
