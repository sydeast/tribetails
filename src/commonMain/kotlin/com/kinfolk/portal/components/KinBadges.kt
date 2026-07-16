package com.kinfolk.portal.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.LocalKinfolkTypography
import com.kinfolk.portal.util.CalendarBadge

/**
 * Little calendar tile from the mockups' `.cal` block: accent month bar
 * over a serif day number on white. Renders nothing when [badge] is null
 * (no date on the row), so rows without timestamps simply skip the tile.
 */
@Composable
fun KinCalendarBadge(
    badge: CalendarBadge?,
    accent: Color,
    modifier: Modifier = Modifier,
) {
    if (badge == null) return
    val type = LocalKinfolkTypography.current
    val shape = RoundedCornerShape(13.dp)
    Column(
        modifier = modifier
            .width(52.dp)
            .clip(shape)
            .background(Color.White)
            .border(1.dp, KinfolkBrand.NavyHairline, shape),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            modifier = Modifier.fillMaxWidth().background(accent).padding(vertical = 3.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(badge.month, style = type.sansMeta.copy(color = Color.White, fontSize = 10.sp))
        }
        Text(
            badge.day,
            style = type.heritageTitle.copy(fontSize = 20.sp),
            modifier = Modifier.padding(vertical = 4.dp),
        )
    }
}

/** Tinted status chip from the mockups' `.chip` — 14% accent fill, mono caps. */
@Composable
fun KinTintPill(
    label: String,
    color: Color,
    modifier: Modifier = Modifier,
) {
    val type = LocalKinfolkTypography.current
    Box(
        modifier = modifier
            .clip(KinfolkShapes.pill)
            .background(color.copy(alpha = 0.14f))
            .padding(horizontal = 10.dp, vertical = 4.dp),
    ) {
        Text(label, style = type.sansMeta.copy(color = color, fontSize = 10.5.sp))
    }
}
