package com.tribetails.auntieos.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme

@Composable
fun PrimaryButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loading: Boolean = false,
    leading: (@Composable () -> Unit)? = null,
) {
    val bg = when {
        !enabled -> AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.18f).compositeOver(AuntieTheme.colors.surface)
        else     -> AuntieTheme.colors.kinfolkOrange
    }
    // #9: a gradient accent paints the button with the brand gradient brush.
    val brush = AuntieTheme.colors.accentBrush

    Box(
        modifier = modifier
            .height(40.dp)
            .clip(RoundedCornerShape(8.dp))
            .then(if (brush != null && enabled) Modifier.background(brush) else Modifier.background(bg))
            .border(BorderStroke(1.dp, SolidColor(AuntieTheme.colors.kinfolkOrange)), RoundedCornerShape(8.dp))
            .clickable(enabled = enabled && !loading, onClick = onClick)
            .padding(horizontal = 18.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (loading) {
            AuntieSpinner(
                modifier = Modifier.size(16.dp),
                strokeWidth = 2.dp,
                color = AuntieTheme.colors.background,
            )
        } else {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                leading?.invoke()
                Text(
                    text = label,
                    style = AuntieTheme.typography.labelLarge,
                    color = if (enabled) AuntieTheme.colors.background else AuntieTheme.colors.textDim,
                )
            }
        }
    }
}
