package com.tribetails.auntieos.ui.components

import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme

@Composable
fun AuntieLoadingIndicator(
    modifier: Modifier = Modifier,
    size: Int = 40,
    strokeWidth: Int = 3
) {
    AuntieSpinner(
        modifier = modifier.size(size.dp),
        color = AuntieTheme.colors.kinfolkOrange,
        strokeWidth = strokeWidth.dp
    )
}

@Composable
fun LoadingScreen(
    message: String = "Loading...",
    modifier: Modifier = Modifier
) {
    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            AuntieLoadingIndicator(size = 48, strokeWidth = 4)
            Text(
                text = message,
                style = AuntieTheme.typography.bodyMedium,
                color = AuntieTheme.colors.textDim
            )
        }
    }
}

@Composable
fun LoadingCard(
    modifier: Modifier = Modifier
) {
    AuntieCard(
        modifier = modifier.fillMaxWidth(),
        containerColor = AuntieTheme.colors.surface,
        border = androidx.compose.foundation.BorderStroke(0.5.dp, AuntieTheme.colors.border)
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(80.dp),
            contentAlignment = Alignment.Center
        ) {
            AuntieLoadingIndicator()
        }
    }
}

@Composable
fun PulsingDot(
    color: Color = AuntieTheme.colors.kinfolkOrange,
    size: Int = 8,
    delay: Int = 0
) {
    val infiniteTransition = rememberInfiniteTransition(label = "pulsing")
    val scale by infiniteTransition.animateFloat(
        initialValue = 0.0f,
        targetValue = 1.0f,
        animationSpec = infiniteRepeatable(
            animation = keyframes {
                durationMillis = 1200
                0.0f at delay
                1.0f at delay + 300
                0.0f at delay + 600
            }
        ),
        label = "scale"
    )

    Box(
        modifier = Modifier
            .size(size.dp)
            .scale(scale)
            .clip(CircleShape)
            .background(color)
    )
}

@Composable
fun TypingIndicator(
    modifier: Modifier = Modifier,
    dotColor: Color = AuntieTheme.colors.kinfolkOrange
) {
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = "Loading",
            style = AuntieTheme.typography.bodySmall,
            color = AuntieTheme.colors.textDim
        )
        Spacer(Modifier.width(4.dp))
        PulsingDot(color = dotColor, delay = 0)
        PulsingDot(color = dotColor, delay = 200)
        PulsingDot(color = dotColor, delay = 400)
    }
}

@Composable
fun ShimmerCard(
    modifier: Modifier = Modifier,
    height: Int = 80
) {
    val transition = rememberInfiniteTransition(label = "shimmer")
    val anim by transition.animateFloat(
        initialValue = -1f,
        targetValue = 2f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1500, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "shimmerOffset",
    )
    val brush = Brush.linearGradient(
        colors = listOf(AuntieTheme.colors.surface2, AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.18f), AuntieTheme.colors.surface2),
        start = Offset(anim * 600f, 0f),
        end = Offset(anim * 600f + 240f, 0f),
    )

    AuntieCard(
        modifier = modifier.fillMaxWidth(),
        containerColor = AuntieTheme.colors.surface,
        border = androidx.compose.foundation.BorderStroke(0.5.dp, AuntieTheme.colors.border)
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(height.dp)
                .background(brush)
        )
    }
}

@Composable
fun LoadingButton(
    onClick: () -> Unit,
    text: String,
    isLoading: Boolean,
    modifier: Modifier = Modifier,
    enabled: Boolean = true
) {
    PrimaryButton(
        label = text,
        onClick = onClick,
        modifier = modifier.height(48.dp),
        enabled = enabled,
        loading = isLoading
    )
}

@Composable
fun ShimmerBar(
    modifier: Modifier = Modifier,
    height: Dp = 14.dp,
    cornerRadius: Dp = 4.dp,
) {
    val transition = rememberInfiniteTransition(label = "shimmer")
    val anim by transition.animateFloat(
        initialValue = -1f,
        targetValue = 2f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1500, easing = LinearEasing),
            repeatMode = RepeatMode.Restart,
        ),
        label = "shimmerOffset",
    )
    val brush = Brush.linearGradient(
        colors = listOf(AuntieTheme.colors.surface2, AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.18f), AuntieTheme.colors.surface2),
        start = Offset(anim * 600f, 0f),
        end = Offset(anim * 600f + 240f, 0f),
    )

    Box(
        modifier
            .fillMaxWidth()
            .height(height)
            .clip(RoundedCornerShape(cornerRadius))
            .background(brush),
    )
}

@Composable
fun SkeletonText(
    modifier: Modifier = Modifier,
    lines: Int = 1
) {
    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        repeat(lines) { index ->
            ShimmerBar(
                modifier = Modifier.fillMaxWidth(if (index == lines - 1) 0.7f else 1f),
                height = 16.dp,
                cornerRadius = 8.dp,
            )
        }
    }
}
