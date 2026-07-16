package com.kinfolk.portal.screens.kin

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kinfolk.portal.components.EmptyState
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinSpinner
import com.kinfolk.portal.components.KinfolkRemoteImage
import com.kinfolk.portal.components.ScreenHeader
import com.kinfolk.portal.nav.avatarInitial
import com.kinfolk.portal.portal.Kin
import com.kinfolk.portal.portal.KinStatus
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkGradients
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography

/**
 * Kin list. Detail selection is lifted into nav: tapping a card emits
 * [onOpenKin] (id) and the host routes to KinDetailRoute. Add stays an in-screen
 * dialog (no shareable URL needed); edit is promoted to KinAddEditRoute via the
 * detail screen. The list + add/edit/archive state lives in the shared
 * controller so the lifted detail / edit destinations refresh one source.
 *
 * Layout follows ui-ideas/mytribe-kin-2026-05-31.html: a responsive pet-card
 * grid (3-up at the 880dp shell breakpoint, 2-up mid, 1-up narrow), a dashed
 * add card at the end of the active grid, and a muted Family Purple memorial
 * treatment for Kin no longer with us.
 */
@Composable
fun KinScreen(
    familyName: String,
    kinfolkId: String,
    portalApi: PortalApi,
    onOpenKin: (String) -> Unit = {},
    controller: KinController = rememberKinController(kinfolkId, portalApi),
) {
    val type = LocalKinfolkTypography.current
    val data = controller.data
    val error = controller.error
    var addNew by remember { mutableStateOf(false) }

    LaunchedEffect(kinfolkId) {
        controller.reload()
        controller.loadSchema()
        controller.loadBreeds()
    }

    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val columns = kinGridColumns(maxWidth.value)
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f).padding(end = KinfolkSpacing.m)) {
                    Text(text = "The Kin", style = type.heritageTitle)
                    Text(
                        text = "Everyone who shares your home. Tap a card to open the full profile.",
                        style = type.sansLabel.copy(color = KinfolkBrand.NavyMuted),
                    )
                }
                KinButton(label = "Add New", onClick = { addNew = true })
            }
            controller.photoNotice?.let { notice ->
                GlassCard(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                    contentPadding = PaddingValues(KinfolkSpacing.m),
                ) {
                    Row(
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            text = notice,
                            style = type.sansLabel,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            text = "Dismiss",
                            style = type.sansLabel.copy(color = KinfolkBrand.KinfolkOrange),
                            modifier = Modifier
                                .padding(start = KinfolkSpacing.s)
                                .clip(KinfolkShapes.pill)
                                .clickable { controller.photoNotice = null }
                                .padding(horizontal = KinfolkSpacing.xs, vertical = 2.dp),
                        )
                    }
                }
            }
            if (controller.photoUploading) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                    horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CircularProgressIndicator(color = KinfolkBrand.KinfolkOrange, modifier = Modifier.size(16.dp))
                    Text("Uploading photo…", style = type.sansLabel)
                }
            }
            when {
                error != null -> EmptyState(title = "Couldn't load Kin", message = error ?: "")
                data == null -> Box(modifier = Modifier.fillMaxWidth().padding(KinfolkSpacing.l), contentAlignment = Alignment.Center) {
                    KinSpinner()
                }
                data!!.kin.isEmpty() -> EmptyState(
                    title = "No Kin added yet",
                    message = "Add the pets in your home: names, breeds, photos, care details. Tap each card for full profile.",
                )
                else -> {
                    val active = data!!.kin.filter { it.status == KinStatus.Active }
                    val gone = data!!.kin.filter { it.status == KinStatus.NoLongerWithUs }
                    KinCardGrid(
                        kin = active,
                        columns = columns,
                        onOpenKin = onOpenKin,
                        trailingAddCard = true,
                        onAdd = { addNew = true },
                    )
                    if (gone.isNotEmpty()) {
                        Spacer(Modifier.height(KinfolkSpacing.s))
                        Text(
                            text = "No Longer With Us",
                            style = type.heritageSection,
                            modifier = Modifier.padding(horizontal = KinfolkSpacing.l),
                        )
                        KinCardGrid(
                            kin = gone,
                            columns = columns,
                            onOpenKin = onOpenKin,
                            trailingAddCard = false,
                            onAdd = {},
                        )
                    }
                }
            }
            Spacer(Modifier.height(KinfolkSpacing.l))
        }
    }

    if (addNew) {
        AddEditKinDialog(
            initial = null,
            schema = controller.schema,
            dogBreeds = controller.breeds.dogBreeds,
            catBreeds = controller.breeds.catBreeds,
            onClose = { addNew = false },
            onSubmit = { payload, photo -> controller.addAndReload(payload, photo) },
        )
    }
}

/**
 * Destination composable for KinAddEditRoute. Hosts the add/edit dialog as a
 * modal over the Kin tab. Edit resolves the Kin by id from the shared
 * controller; a null kinId means add. Dismiss / submit both pop back to the
 * list (via [onClose]); submit routes the write through the same controller so
 * the list refreshes.
 */
@Composable
fun KinAddEditScreen(
    kinId: String?,
    controller: KinController,
    onClose: () -> Unit,
) {
    val editing = kinId?.let { controller.find(it) }
    AddEditKinDialog(
        initial = editing,
        schema = controller.schema,
        dogBreeds = controller.breeds.dogBreeds,
        catBreeds = controller.breeds.catBreeds,
        onClose = onClose,
        onSubmit = { payload, photo ->
            if (kinId != null) controller.updateAndReload(kinId, payload, photo) else controller.addAndReload(payload, photo)
        },
    )
}

/**
 * Destination composable for KinDetailRoute. Resolves the Kin by id from the
 * shared controller, then renders the existing detail view. Edit navigates to
 * KinAddEditRoute via [onEdit]; archive routes through the controller and pops
 * back on success (via [onBack]).
 */
@Composable
fun KinDetailHost(
    familyName: String,
    kinId: String,
    controller: KinController,
    onBack: () -> Unit,
    onEdit: (String) -> Unit,
) {
    val kin = controller.find(kinId)
    if (kin == null) {
        Column(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
        ) {
            ScreenHeader(title = "The Kin")
            EmptyState(
                title = "Kin not found",
                message = "This profile is no longer available.",
            )
        }
        return
    }
    KinDetailScreen(
        familyName = familyName,
        kin = kin,
        onBack = onBack,
        onEdit = { onEdit(kin.id) },
        onArchive = { restore -> controller.archive(kin.id, restore, onDone = onBack) },
    )
}

// ---- Grid + cards (per mytribe-kin mockup) ----

/**
 * Pet-card grid column count. Mirrors the mockup's CSS breakpoints:
 * 3-up at/above the 880dp shell breakpoint, 2-up down to 560dp, 1-up narrow.
 */
internal fun kinGridColumns(widthDp: Float): Int = when {
    widthDp >= 880f -> 3
    widthDp >= 560f -> 2
    else -> 1
}

/** Age line for a pet card, e.g. "4 yrs"; "Age not set" when unknown. */
internal fun kinAgeLabel(ageYears: Double?): String = when {
    ageYears == null -> "Age not set"
    ageYears % 1.0 == 0.0 -> "${ageYears.toInt()} yrs"
    else -> "$ageYears yrs"
}

/** Card photo-tint cycle: orange → teal → pink → purple, like the mockup. */
private val KinCardTints = listOf(
    KinfolkBrand.KinfolkOrange,
    KinfolkBrand.KinTeal,
    KinfolkBrand.PackPink,
    KinfolkBrand.FamilyPurple,
)

@Composable
private fun KinCardGrid(
    kin: List<Kin>,
    columns: Int,
    onOpenKin: (String) -> Unit,
    trailingAddCard: Boolean,
    onAdd: () -> Unit,
) {
    // Cells are laid out row-by-row inside the screen's single scroll column
    // (no LazyGrid: the page scrolls as one piece, like the other tabs).
    val cells: List<@Composable (Modifier) -> Unit> = buildList {
        kin.forEachIndexed { index, k ->
            add { m -> KinCard(k, index, onClick = { onOpenKin(k.id) }, modifier = m) }
        }
        if (trailingAddCard) add { m -> AddKinCard(onAdd, modifier = m) }
    }
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
    ) {
        cells.chunked(columns).forEach { rowCells ->
            Row(
                modifier = Modifier.fillMaxWidth().height(IntrinsicSize.Max),
                horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
            ) {
                rowCells.forEach { cell -> cell(Modifier.weight(1f).fillMaxHeight()) }
                repeat(columns - rowCells.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    }
}

@Composable
private fun KinCard(kin: Kin, index: Int, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val type = LocalKinfolkTypography.current
    val memorial = kin.status == KinStatus.NoLongerWithUs
    val tint = if (memorial) KinfolkBrand.FamilyPurple else KinCardTints[index % KinCardTints.size]
    val shape = KinfolkShapes.card
    val bg = if (memorial) KinfolkBrand.FamilyPurple.copy(alpha = 0.08f) else KinfolkBrand.GlassSurface
    val borderColor = if (memorial) KinfolkBrand.FamilyPurple.copy(alpha = 0.30f) else KinfolkBrand.GlassBorder
    val name = kin.name ?: "Unnamed Kin"
    Column(
        modifier = modifier
            .clip(shape)
            .background(bg)
            .border(1.dp, borderColor, shape)
            .clickable { onClick() }
            .padding(KinfolkSpacing.m),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.xs),
    ) {
        if (memorial) {
            Box(
                modifier = Modifier
                    .clip(KinfolkShapes.pill)
                    .background(KinfolkBrand.FamilyPurple.copy(alpha = 0.15f))
                    .padding(horizontal = KinfolkSpacing.m, vertical = 4.dp),
            ) {
                Text("In our hearts", style = type.sansMeta.copy(color = KinfolkBrand.FamilyPurple))
            }
        }
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(4f / 3f)
                .clip(KinfolkShapes.cardSmall)
                .background(tint.copy(alpha = if (memorial) 0.16f else 0.15f)),
            contentAlignment = Alignment.Center,
        ) {
            val photo = kin.photoUrl
            if (!photo.isNullOrBlank()) {
                KinfolkRemoteImage(
                    url = photo,
                    contentDescription = name,
                    modifier = Modifier.fillMaxSize(),
                    cornerRadius = 0.dp,
                )
            } else {
                Text(
                    text = avatarInitial(name),
                    style = type.heritageDisplay.copy(fontSize = 44.sp, color = tint),
                )
            }
        }
        Spacer(Modifier.height(KinfolkSpacing.xs))
        Text(
            text = name,
            style = type.heritageTitle.copy(color = if (memorial) KinfolkBrand.FamilyPurple else KinfolkBrand.Navy),
        )
        val breedLine = (kin.breed ?: kin.species)?.takeIf { it.isNotBlank() }
        if (breedLine != null) {
            Text(text = breedLine, style = type.sansLabel.copy(color = KinfolkBrand.NavySoft))
        }
        Text(
            text = kinAgeLabel(kin.ageYears).uppercase(),
            style = type.sansMeta.copy(
                color = if (memorial) KinfolkBrand.FamilyPurple.copy(alpha = 0.85f) else KinfolkBrand.NavyMuted,
            ),
        )
    }
}

/** Dashed "new profile" cell that closes the active grid, per the mockup. */
@Composable
private fun AddKinCard(onAdd: () -> Unit, modifier: Modifier = Modifier) {
    val type = LocalKinfolkTypography.current
    val shape = KinfolkShapes.card
    Column(
        modifier = modifier
            .clip(shape)
            .background(KinfolkBrand.GlassSurfaceDim)
            .border(2.dp, KinfolkBrand.NavyHairline, shape)
            .clickable { onAdd() }
            .padding(KinfolkSpacing.l),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(
            modifier = Modifier
                .size(56.dp)
                .clip(CircleShape)
                .background(KinfolkGradients.tribe),
            contentAlignment = Alignment.Center,
        ) {
            Text("+", style = type.heritageTitle.copy(color = Color.White))
        }
        Spacer(Modifier.height(KinfolkSpacing.s))
        Text("NEW KIN PROFILE", style = type.sansMeta)
    }
}
