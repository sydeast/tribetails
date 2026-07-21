package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.*
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Lucide
import com.composables.icons.lucide.X
import com.tribetails.auntieos.web.theme.AuntieTheme

enum class AuntieButtonState { IDLE, LOADING, SUCCESS, ERROR }

@Composable
fun Modifier.pressScale(
    source: MutableInteractionSource,
    pressedScale: Float = 0.95f,
): Modifier {
    val isPressed by source.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue   = if (isPressed) pressedScale else 1f,
        animationSpec = spring(stiffness = Spring.StiffnessMediumLow, dampingRatio = Spring.DampingRatioMediumBouncy),
        label         = "pressScale",
    )
    return this.scale(scale)
}

@Composable
fun GradientButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    brush: Brush = Brush.linearGradient(AuntieTheme.colors.orangeToPinkColors),
    enabled: Boolean = true,
    loading: Boolean = false,
    leading: (@Composable () -> Unit)? = null,
    glowColor: Color = AuntieTheme.colors.primary,
    showGlow: Boolean = true,
) {
    val c = AuntieTheme.colors
    val source = remember { MutableInteractionSource() }
    val effectiveBrush = if (enabled) brush else Brush.linearGradient(listOf(c.surface2, c.surface2))
    val textColor = if (enabled) c.background else c.textFaint

    Box(
        modifier = modifier
            .height(44.dp)
            .clip(RoundedCornerShape(12.dp))
            .then(
                if (enabled && showGlow) Modifier.drawBehind {
                    // CMP-safe multi-layer glow (no setShadowLayer)
                    repeat(3) { i ->
                        val expand = ((3 - i) * 4).dp.toPx()
                        drawRoundRect(
                            color        = glowColor.copy(alpha = 0.10f - i * 0.03f),
                            topLeft      = Offset(-expand, -expand),
                            size         = Size(size.width + expand * 2f, size.height + expand * 2f),
                            cornerRadius = CornerRadius(12.dp.toPx() + expand),
                        )
                    }
                } else Modifier
            )
            .background(effectiveBrush)
            .pressScale(source)
            .clickable(
                interactionSource = source,
                indication        = null,
                enabled           = enabled && !loading,
                onClick           = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        if (loading) {
            AuntieSpinner(modifier = Modifier.size(18.dp), color = c.background, strokeWidth = 2.dp)
        } else {
            Row(
                verticalAlignment     = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier              = Modifier.padding(horizontal = 20.dp),
            ) {
                leading?.invoke()
                Text(
                    text       = label,
                    style      = AuntieTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold,
                    color      = textColor,
                )
            }
        }
    }
}

@Composable
fun MorphingButton(
    label: String,
    onClick: () -> Unit,
    state: AuntieButtonState = AuntieButtonState.IDLE,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val c = AuntieTheme.colors
    val source = remember { MutableInteractionSource() }

    val bgColor by animateColorAsState(
        targetValue = when (state) {
            AuntieButtonState.SUCCESS -> c.success
            AuntieButtonState.ERROR   -> c.error
            else                      -> c.primary
        },
        animationSpec = tween(300),
        label         = "morphBg",
    )

    Box(
        modifier = modifier
            .height(44.dp)
            .clip(RoundedCornerShape(12.dp))
            .background(if (enabled) bgColor else c.surface2)
            .pressScale(source)
            .clickable(
                interactionSource = source,
                indication        = null,
                enabled           = enabled && state == AuntieButtonState.IDLE,
                onClick           = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        AnimatedContent(
            targetState  = state,
            transitionSpec = {
                (fadeIn(tween(200)) + scaleIn(initialScale = 0.8f, animationSpec = spring(dampingRatio = Spring.DampingRatioMediumBouncy)))
                    .togetherWith(fadeOut(tween(100)) + scaleOut(targetScale = 0.8f, animationSpec = tween(100)))
            },
            label = "morphContent",
        ) { s ->
            when (s) {
                AuntieButtonState.IDLE    -> Text(label, style = AuntieTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = c.background, modifier = Modifier.padding(horizontal = 20.dp))
                AuntieButtonState.LOADING -> AuntieSpinner(Modifier.size(18.dp), color = c.background, strokeWidth = 2.dp)
                AuntieButtonState.SUCCESS -> Icon(Lucide.Check, contentDescription = "Done",  tint = c.background, modifier = Modifier.size(20.dp))
                AuntieButtonState.ERROR   -> Icon(Lucide.X,     contentDescription = "Error", tint = c.background, modifier = Modifier.size(20.dp))
            }
        }
    }
}

@Composable
fun GlowFab(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    glowColor: Color = AuntieTheme.colors.primary,
    content: @Composable () -> Unit,
) {
    val infiniteTransition = rememberInfiniteTransition(label = "fabGlow")
    val ringScale by infiniteTransition.animateFloat(
        initialValue  = 1f,
        targetValue   = 1.35f,
        animationSpec = infiniteRepeatable(tween(1000, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label         = "fabRing",
    )
    val ringAlpha by infiniteTransition.animateFloat(
        initialValue  = 0.35f,
        targetValue   = 0f,
        animationSpec = infiniteRepeatable(tween(1000, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label         = "fabAlpha",
    )
    val source = remember { MutableInteractionSource() }

    Box(contentAlignment = Alignment.Center) {
        Box(
            modifier = Modifier
                .size(56.dp)
                .scale(ringScale)
                .clip(CircleShape)
                .background(glowColor.copy(alpha = ringAlpha)),
        )
        Box(
            modifier = modifier
                .size(56.dp)
                .clip(CircleShape)
                .background(glowColor)
                .pressScale(source)
                .clickable(interactionSource = source, indication = null, onClick = onClick),
            contentAlignment = Alignment.Center,
        ) {
            content()
        }
    }
}
