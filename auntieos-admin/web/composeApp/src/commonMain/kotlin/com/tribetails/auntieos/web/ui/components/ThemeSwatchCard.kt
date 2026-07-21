package com.tribetails.auntieos.web.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * A selectable theme preset card showing the preset's dominant + accent swatch.
 * Shared by the AuntieOS Appearance picker (staff-UI themes) and the MyTribe
 * portal theme picker — both pick from the same nine brand-derived presets, so
 * the card renderer lives once here.
 *
 * @param dominant the surface/background feel of the preset
 * @param accent   the preset's sharp brand accent
 */
@Composable
fun ThemeSwatchCard(
    label: String,
    dominant: Color,
    accent: Color,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    blurb: String? = null,
) {
    val c = AuntieTheme.colors
    Column(
        modifier = modifier
            .width(132.dp)
            .clip(RoundedCornerShape(14.dp))
            .border(
                width = if (selected) 2.5.dp else AuntieTheme.dims.borderHairline,
                color = if (selected) c.primary else c.border,
                shape = RoundedCornerShape(14.dp),
            )
            .background(c.surface)
            .clickable { onClick() }
            .padding(8.dp),
    ) {
        // Swatch preview: dominant fill with an accent dot + a check when selected.
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(48.dp)
                .clip(RoundedCornerShape(9.dp))
                .background(dominant),
            contentAlignment = Alignment.CenterEnd,
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(end = 8.dp),
            ) {
                if (selected) {
                    Icon(
                        Lucide.Check,
                        contentDescription = "Selected",
                        tint = accent,
                        modifier = Modifier.size(16.dp),
                    )
                    Spacer(Modifier.width(4.dp))
                }
                Box(
                    modifier = Modifier
                        .size(20.dp)
                        .clip(RoundedCornerShape(999.dp))
                        .background(accent)
                        .border(AuntieTheme.dims.borderHairline, c.border.copy(alpha = 0.4f), RoundedCornerShape(999.dp)),
                )
            }
        }
        Spacer(Modifier.height(6.dp))
        Text(
            label,
            style = AuntieTheme.typography.titleSmall,
            color = if (selected) c.textPrimary else c.textDim,
        )
        if (blurb != null) {
            Text(
                blurb,
                style = AuntieTheme.typography.labelSmall,
                color = c.textFaint,
                maxLines = 2,
            )
        }
    }
}
