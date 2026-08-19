package com.kinfolk.portal.screens.tribe

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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinGhostButton
import com.kinfolk.portal.components.KinSpinner
import com.kinfolk.portal.components.KinfolkAvatar
import com.kinfolk.portal.components.ScreenHeader
import com.kinfolk.portal.portal.Kin
import com.kinfolk.portal.portal.KinTale
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.portal.TribeProfileResult
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import com.kinfolk.portal.util.relativeTime

/**
 * The Tribe tab as a family-base HUB (per smoke-test): Kin profile cards, a
 * photo gallery, Home info summary, and a recent KinTales feed — with profile
 * editing moved behind an Edit button (and the avatar menu). KinTales is no
 * longer a top-nav tab; it lives here and is still reachable via "All tales".
 * Read-only surface — every section links out to its dedicated screen.
 */
@Composable
fun TribeHubScreen(
    familyName: String,
    kinfolkId: String,
    portalApi: PortalApi,
    onEditProfile: () -> Unit,
    onOpenKinDetail: (String) -> Unit,
    onManageKin: () -> Unit,
    onOpenKinTales: () -> Unit,
    onOpenGallery: () -> Unit,
) {
    val type = LocalKinfolkTypography.current
    var kin by remember { mutableStateOf<List<Kin>?>(null) }
    var kinFailed by remember { mutableStateOf(false) }
    var tales by remember { mutableStateOf<List<KinTale>?>(null) }
    var talesFailed by remember { mutableStateOf(false) }
    var profile by remember { mutableStateOf<TribeProfileResult?>(null) }

    LaunchedEffect(kinfolkId) {
        try { kin = portalApi.getMyKin(kinfolkId).kin; kinFailed = false } catch (_: Throwable) { kinFailed = true }
    }
    LaunchedEffect(kinfolkId) {
        try { tales = portalApi.getMyKinTales(kinfolkId, limit = 4).tales; talesFailed = false } catch (_: Throwable) { talesFailed = true }
    }
    LaunchedEffect(kinfolkId) {
        try { profile = portalApi.getMyTribeProfile(kinfolkId) } catch (_: Throwable) { /* home info card hides */ }
    }

    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
    ) {
        ScreenHeader(
            title = familyName.ifBlank { "Your family base" },
            kicker = "Your family base",
        )
        KinGhostButton(
            label = "Edit Tribe Profile",
            onClick = onEditProfile,
            modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        )

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

        // ---- Gallery (Kin faces here; "All photos" opens the whole archive) ----
        // The strip is the roster's portraits, so it hides when no Kin has a
        // photo on file. Same gating the web hub applies to the same card.
        val withPhotos = kin?.filter { !it.photoUrl.isNullOrBlank() }.orEmpty()
        if (withPhotos.isNotEmpty()) {
            SectionCard(title = "Gallery", linkText = "All photos", onLink = onOpenGallery) {
                LazyRow(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                    items(withPhotos) { k ->
                        KinfolkAvatar(
                            url = k.photoUrl.orEmpty(),
                            contentDescription = k.name ?: "Kin",
                            size = 64.dp,
                        )
                    }
                }
            }
        }

        // ---- KinTales feed ----
        SectionCard(title = "KinTales", linkText = "All tales", onLink = onOpenKinTales) {
            when {
                talesFailed -> Text("KinTales unavailable right now.", style = type.sansBody.copy(color = KinfolkBrand.NavyMuted))
                tales == null -> Box(Modifier.fillMaxWidth().padding(KinfolkSpacing.m), contentAlignment = Alignment.Center) { KinSpinner() }
                tales!!.isEmpty() -> Text("After each visit, your Auntie's KinTale lands here.", style = type.sansBody.copy(color = KinfolkBrand.NavyMuted))
                else -> Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                    tales!!.take(3).forEach { TaleLine(it) }
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
                    p.profile.customFields.firstOrNull { it.key == "vetClinicName" && it.value.isNotBlank() }?.let { add("Vet: ${it.value}") }
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

@Composable
private fun TaleLine(tale: KinTale) {
    val type = LocalKinfolkTypography.current
    Column(modifier = Modifier.fillMaxWidth()) {
        Text(
            text = tale.body.ifBlank { "A new tale from your Auntie" },
            style = type.sansBody,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )
        val meta = buildString {
            append("FROM ")
            append((tale.authorDisplayName ?: "YOUR AUNTIE").uppercase())
            tale.sentAtMs?.let { append(" · "); append(relativeTime(it).uppercase()) }
        }
        Text(meta, style = type.sansMeta)
    }
}
