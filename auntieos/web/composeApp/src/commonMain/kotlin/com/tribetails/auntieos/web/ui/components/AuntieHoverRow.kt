package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.*
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.hoverable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.theme.AuntieTheme

data class RowAction(
    val icon: ImageVector,
    val label: String,
    val color: Color,
    val onClick: () -> Unit,
)

@Composable
fun HoverActionsRow(
    actions: List<RowAction>,
    modifier: Modifier = Modifier,
    cornerRadius: androidx.compose.ui.unit.Dp = 8.dp,
    content: @Composable () -> Unit,
) {
    val source = remember { MutableInteractionSource() }
    val hovered by source.collectIsHoveredAsState()

    Box(
        modifier = modifier
            .clip(RoundedCornerShape(cornerRadius))
            .hoverable(source),
    ) {
        content()
        AnimatedVisibility(
            visible  = hovered,
            modifier = Modifier.align(Alignment.CenterEnd),
            enter    = fadeIn(tween(150)) + slideInHorizontally(tween(150)) { it / 2 },
            exit     = fadeOut(tween(100)) + slideOutHorizontally(tween(100)) { it / 2 },
        ) {
            Row(
                modifier = Modifier
                    .padding(end = 8.dp)
                    .clip(RoundedCornerShape(8.dp)),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                actions.forEach { action ->
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .background(action.color.copy(alpha = 0.9f))
                            .clickable(onClick = action.onClick)
                            .padding(horizontal = 10.dp, vertical = 6.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Row(
                            verticalAlignment     = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Icon(action.icon, contentDescription = action.label, tint = Color.White, modifier = Modifier.size(14.dp))
                            Text(action.label, style = AuntieTheme.typography.labelSmall, color = Color.White, fontWeight = FontWeight.SemiBold)
                        }
                    }
                }
            }
        }
    }
}
