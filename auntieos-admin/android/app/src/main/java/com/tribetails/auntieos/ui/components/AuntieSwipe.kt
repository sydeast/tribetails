package com.tribetails.auntieos.ui.components

import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
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
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlin.math.roundToInt

data class SwipeAction(
    val icon: ImageVector,
    val label: String,
    val color: Color,
    val onClick: () -> Unit,
)

@Composable
fun SwipeToActionsRow(
    actions: List<SwipeAction>,
    modifier: Modifier = Modifier,
    cornerRadius: androidx.compose.ui.unit.Dp = 12.dp,
    content: @Composable () -> Unit,
) {
    val density = LocalDensity.current
    val actionWidthDp = 64.dp
    val totalRevealDp = actionWidthDp * actions.size
    val totalRevealPx = with(density) { totalRevealDp.toPx() }

    var rawOffset by remember { mutableFloatStateOf(0f) }
    var snapTarget by remember { mutableFloatStateOf(0f) }
    val animatedOffset by animateFloatAsState(
        targetValue   = snapTarget,
        animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy, stiffness = Spring.StiffnessMediumLow),
        label         = "swipeOffset",
    )
    val draggableState = rememberDraggableState { delta ->
        rawOffset = (rawOffset + delta).coerceIn(-totalRevealPx, 8f)
        snapTarget = rawOffset
    }

    Box(modifier = modifier.clip(RoundedCornerShape(cornerRadius))) {
        Row(
            modifier = Modifier
                .align(Alignment.CenterEnd)
                .fillMaxHeight()
                .width(totalRevealDp),
        ) {
            actions.forEach { action ->
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .background(action.color)
                        .clickable {
                            action.onClick()
                            snapTarget = 0f
                            rawOffset = 0f
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Icon(action.icon, contentDescription = action.label, tint = Color.White, modifier = Modifier.size(18.dp))
                        Text(action.label, style = AuntieTheme.typography.labelSmall, color = Color.White, fontWeight = FontWeight.SemiBold)
                    }
                }
            }
        }
        Box(
            modifier = Modifier
                .offset { IntOffset(animatedOffset.roundToInt(), 0) }
                .fillMaxWidth()
                .draggable(
                    state       = draggableState,
                    orientation = Orientation.Horizontal,
                    onDragStopped = { velocity ->
                        snapTarget = if (-rawOffset > totalRevealPx / 2f || velocity < -600f) {
                            -totalRevealPx
                        } else 0f
                        rawOffset = snapTarget
                    },
                ),
        ) {
            content()
        }
    }
}
