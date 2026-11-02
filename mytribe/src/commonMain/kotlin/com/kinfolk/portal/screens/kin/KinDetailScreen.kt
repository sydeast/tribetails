package com.kinfolk.portal.screens.kin

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinfolkAvatar
import com.kinfolk.portal.components.ScreenHeader
import com.kinfolk.portal.nav.avatarInitial
import com.kinfolk.portal.nav.isWideShell
import com.kinfolk.portal.portal.Kin
import com.kinfolk.portal.portal.KinStatus
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography

/**
 * Kin profile, per ui-ideas/mytribe-kin-detail-2026-05-31.html: crumb row
 * (back + "Profile" + Edit), a hero card with the big round photo, then a
 * 1.6fr/1fr two-column body at the 880dp shell breakpoint (About + Care on the
 * left; Sitter Notes and Emergency Notes on the right). Narrow widths stack the
 * same cards in one column.
 *
 * #1311: this screen reads only. The mockup's Memorial card is gone by ruling;
 * "Mark No Longer With Us" / "Restore as Active" sit at the bottom of
 * [AddEditKinDialog] behind a confirm step. The "In our hearts" pill in the
 * hero stays.
 */
@Composable
fun KinDetailScreen(
    familyName: String,
    kin: Kin,
    onBack: () -> Unit,
    onEdit: () -> Unit = {},
) {
    val type = LocalKinfolkTypography.current
    val memorial = kin.status == KinStatus.NoLongerWithUs

    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val wide = isWideShell(maxWidth.value)
        Column(
            modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
        ) {
            // Crumb row: back, page label, Edit.
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.s),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onBack) {
                    Icon(
                        imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = "Back to Kin",
                        tint = KinfolkBrand.Navy,
                    )
                }
                Text("Profile", style = type.sansMeta, modifier = Modifier.padding(start = KinfolkSpacing.xs))
                Spacer(Modifier.weight(1f))
                KinButton(label = "Edit", onClick = onEdit, modifier = Modifier.padding(end = KinfolkSpacing.m))
            }

            // Hero card: big round photo + name + species chip (+ memorial band).
            GlassCard(
                modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                contentPadding = PaddingValues(KinfolkSpacing.l),
            ) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.l),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    HeroPortrait(kin, memorial)
                    Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                        Text(kin.name ?: "Unnamed Kin", style = type.heritageDisplay)
                        Row(horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
                            kin.species?.takeIf { it.isNotBlank() }?.let { species ->
                                MetaPill(species.uppercase(), KinfolkBrand.KinTeal)
                            }
                            if (memorial) {
                                MetaPill("In our hearts", KinfolkBrand.FamilyPurple)
                            }
                        }
                    }
                }
            }

            val mainColumn: @Composable () -> Unit = {
                AboutCard(kin)
                CareCard(kin)
            }
            val asideColumn: @Composable () -> Unit = {
                NoteCard(
                    sectLabel = "SITTER NOTES",
                    title = "Good to know",
                    body = kin.sitterNotes,
                )
                EmergencyCard(kin.emergencyNotes)
            }
            if (wide) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                    horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.l),
                    verticalAlignment = Alignment.Top,
                ) {
                    Column(modifier = Modifier.weight(1.6f), verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m)) {
                        mainColumn()
                    }
                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m)) {
                        asideColumn()
                    }
                }
            } else {
                Column(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l),
                    verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.m),
                ) {
                    mainColumn()
                    asideColumn()
                }
            }
            Spacer(Modifier.height(KinfolkSpacing.l))
        }
    }
}

// ---- Hero pieces ----

@Composable
private fun HeroPortrait(kin: Kin, memorial: Boolean) {
    val type = LocalKinfolkTypography.current
    val tint = if (memorial) KinfolkBrand.FamilyPurple else KinfolkBrand.KinfolkOrange
    Box(
        modifier = Modifier
            .size(112.dp)
            .clip(CircleShape)
            .background(tint.copy(alpha = 0.16f))
            .border(3.dp, Color.White, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        val photo = kin.photoUrl
        if (!photo.isNullOrBlank()) {
            KinfolkAvatar(url = photo, contentDescription = kin.name, size = 106.dp)
        } else {
            Text(
                text = avatarInitial(kin.name),
                style = type.heritageDisplay.copy(fontSize = 44.sp, color = tint),
            )
        }
    }
}

@Composable
private fun MetaPill(label: String, color: Color) {
    val type = LocalKinfolkTypography.current
    Box(
        modifier = Modifier
            .clip(KinfolkShapes.pill)
            .background(color.copy(alpha = 0.14f))
            .padding(horizontal = KinfolkSpacing.m, vertical = 5.dp),
    ) {
        Text(label, style = type.sansMeta.copy(color = color))
    }
}

// ---- Body cards ----

@Composable
private fun SectLabel(text: String, color: Color = KinfolkBrand.NavyMuted) {
    val type = LocalKinfolkTypography.current
    Text(text, style = type.sansMeta.copy(color = color))
}

@Composable
private fun AboutCard(kin: Kin) {
    val type = LocalKinfolkTypography.current
    GlassCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(KinfolkSpacing.l)) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            SectLabel("ABOUT")
            Text("The basics", style = type.heritageSection)
            FactList(
                listOfNotNull(
                    kin.species?.takeIf { it.isNotBlank() }?.let { "SPECIES" to it },
                    kin.breed?.takeIf { it.isNotBlank() }?.let { "BREED" to it },
                    kin.ageYears?.let { "AGE" to kinAgeLabel(it) },
                    kin.sex?.takeIf { it.isNotBlank() }?.let { "SEX" to it },
                    kin.weight?.takeIf { it.isNotBlank() }?.let { "WEIGHT" to it },
                    kin.colorMarkings?.takeIf { it.isNotBlank() }?.let { "MARKINGS" to it },
                    if (kin.spayedNeutered) "FIXED" to "Spayed / neutered" else null,
                ),
            )
        }
    }
}

@Composable
private fun CareCard(kin: Kin) {
    val type = LocalKinfolkTypography.current
    val facts = listOfNotNull(
        kin.feedingInstructions?.takeIf { it.isNotBlank() }?.let { "FEEDING" to it },
        kin.walkingInstructions?.takeIf { it.isNotBlank() }?.let { "WALKING" to it },
        kin.medications?.takeIf { it.isNotBlank() }?.let { "MEDICATIONS" to it },
        kin.allergies?.takeIf { it.isNotBlank() }?.let { "ALLERGIES" to it },
        kin.vetInfo?.takeIf { it.isNotBlank() }?.let { "VET" to it },
    )
    if (facts.isEmpty()) return
    GlassCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(KinfolkSpacing.l)) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            SectLabel("CARE")
            Text("Daily routine and needs", style = type.heritageSection)
            FactList(facts)
        }
    }
}

/** Key/value rows with hairline separators, like the mockup's .facts list. */
@Composable
private fun FactList(facts: List<Pair<String, String>>) {
    val type = LocalKinfolkTypography.current
    Column {
        facts.forEachIndexed { index, (label, value) ->
            if (index > 0) {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .height(1.dp)
                        .background(KinfolkBrand.NavyHairline),
                )
            }
            Row(modifier = Modifier.fillMaxWidth().padding(vertical = KinfolkSpacing.s)) {
                Text(
                    text = label,
                    style = type.sansMeta,
                    modifier = Modifier.width(110.dp).padding(top = 2.dp),
                )
                Text(value, style = type.sansBody, modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun NoteCard(sectLabel: String, title: String, body: String?) {
    if (body.isNullOrBlank()) return
    val type = LocalKinfolkTypography.current
    GlassCard(modifier = Modifier.fillMaxWidth(), contentPadding = PaddingValues(KinfolkSpacing.l)) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            SectLabel(sectLabel)
            Text(title, style = type.heritageSection)
            Text(body, style = type.sansBody.copy(color = KinfolkBrand.NavySoft))
        }
    }
}

/** Coral-bordered emergency card, the loudest surface on the page. */
@Composable
private fun EmergencyCard(notes: String?) {
    if (notes.isNullOrBlank()) return
    val type = LocalKinfolkTypography.current
    val shape = KinfolkShapes.card
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(KinfolkBrand.GlassSurface)
            .border(1.dp, KinfolkBrand.SnuggleCoral.copy(alpha = 0.35f), shape)
            .padding(KinfolkSpacing.l),
        verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
    ) {
        SectLabel("EMERGENCY NOTES", color = KinfolkBrand.SnuggleCoral)
        Text(
            "In case of emergency",
            style = LocalKinfolkTypography.current.heritageSection.copy(color = KinfolkBrand.SnuggleCoral),
        )
        Text(notes, style = type.sansBody)
    }
}
