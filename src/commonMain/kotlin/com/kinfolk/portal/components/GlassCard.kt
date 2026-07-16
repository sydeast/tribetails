package com.kinfolk.portal.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.KinfolkSpacing

/**
 * Cross-platform "glass" surface — translucent fill + soft border.
 * No native blur (avoids platform divergence on web).
 *
 * Phase 4: Replaced M3 Surface with Foundation draws (background + border + clip).
 */
@Composable
fun GlassCard(
    modifier: Modifier = Modifier,
    shape: Shape = KinfolkShapes.card,
    contentPadding: PaddingValues = PaddingValues(KinfolkSpacing.l),
    dim: Boolean = false,
    content: @Composable () -> Unit,
) {
    val bgColor = if (dim) KinfolkBrand.GlassSurfaceDim else KinfolkBrand.GlassSurface
    Box(
        modifier = modifier
            .clip(shape)
            .background(bgColor)
            .border(1.dp, KinfolkBrand.GlassBorder, shape)
            .padding(contentPadding),
    ) {
        content()
    }
}
