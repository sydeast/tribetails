package com.tribetails.auntieos.ui.components

import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.BlurredEdgeTreatment
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlin.math.cos
import kotlin.math.sin

// ─── LiquidGlassSurface ───────────────────────────────────────────────────────
// Translucent frosted glass container. On API 31+ applies real backdrop blur.
// Below API 31 falls back to translucent fill only (no crash, just no blur).
@Composable
fun LiquidGlassSurface(
    modifier: Modifier = Modifier,
    cornerRadius: Dp = 16.dp,
    blurRadius: Dp = 10.dp,
    rimAlpha: Float = 0.35f,
    content: @Composable BoxScope.() -> Unit,
) {
    val c = AuntieTheme.colors
    val blurMod = if (android.os.Build.VERSION.SDK_INT >= 31) {
        Modifier.blur(blurRadius, edgeTreatment = BlurredEdgeTreatment.Unbounded)
    } else Modifier
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(cornerRadius))
            .then(blurMod)
            .background(c.surfaceGlass)
            .border(1.dp, Color.White.copy(alpha = rimAlpha), RoundedCornerShape(cornerRadius)),
        content = content,
    )
}

// ─── GlowCard ─────────────────────────────────────────────────────────────────
// Card with animated sweeping glow rim. Set animated=false for static glow.
@Composable
fun GlowCard(
    modifier: Modifier = Modifier,
    glowColor: Color = AuntieTheme.colors.kinfolkOrange,
    cornerRadius: Dp = 16.dp,
    glowAlpha: Float = 0.65f,
    animated: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = AuntieTheme.colors
    val infiniteTransition = rememberInfiniteTransition(label = "glowSweep")
    val sweepAngle by if (animated) {
        infiniteTransition.animateFloat(
            initialValue  = 0f,
            targetValue   = 360f,
            animationSpec = infiniteRepeatable(
                animation  = tween(durationMillis = 3200, easing = LinearEasing),
                repeatMode = RepeatMode.Restart,
            ),
            label = "glowAngle",
        )
    } else {
        remember { mutableStateOf(0f) }
    }

    Column(
        modifier = modifier
            .clip(RoundedCornerShape(cornerRadius))
            .background(c.surface)
            .drawBehind {
                val cr = CornerRadius(cornerRadius.toPx())
                // Outer soft glow halo
                drawIntoCanvas { canvas ->
                    val paint = Paint()
                    // AGP 9 / Compose 1.11: asFrameworkPaint() → nativePaint extension.
                    paint.nativePaint.apply {
                        isAntiAlias = true
                        color = android.graphics.Color.TRANSPARENT
                        setShadowLayer(
                            8.dp.toPx(), 0f, 0f,
                            glowColor.copy(alpha = 0.35f).toArgb(),
                        )
                    }
                    canvas.drawRoundRect(0f, 0f, size.width, size.height, cr.x, cr.y, paint)
                }
                // Animated sweep rim
                rotate(sweepAngle, pivot = Offset(size.width / 2, size.height / 2)) {
                    drawRoundRect(
                        brush = Brush.sweepGradient(
                            0f    to glowColor.copy(alpha = 0f),
                            0.10f to glowColor.copy(alpha = glowAlpha),
                            0.22f to glowColor.copy(alpha = 0f),
                            1f    to glowColor.copy(alpha = 0f),
                        ),
                        cornerRadius = cr,
                        style = Stroke(width = 1.5.dp.toPx()),
                    )
                }
                // Static base border
                drawRoundRect(
                    color        = c.border,
                    cornerRadius = cr,
                    style        = Stroke(width = 0.5.dp.toPx()),
                )
            },
        content = content,
    )
}

// ─── AnimatedMeshBackground ───────────────────────────────────────────────────
// 4 brand-color radial gradient spots that slowly drift. Use as a Box background.
// Wrap your screen content in a Box with this behind it.
@Composable
fun AnimatedMeshBackground(
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    val t = rememberInfiniteTransition(label = "mesh")

    @Composable fun meshFloat(init: Float, target: Float, dur: Int, label: String) =
        t.animateFloat(
            initialValue  = init,
            targetValue   = target,
            animationSpec = infiniteRepeatable(
                animation  = tween(dur, easing = FastOutSlowInEasing),
                repeatMode = RepeatMode.Reverse,
            ),
            label = label,
        )

    val o1x by meshFloat(0.10f, 0.42f, 8200,  "o1x")
    val o1y by meshFloat(0.08f, 0.34f, 9100,  "o1y")
    val o2x by meshFloat(0.72f, 0.92f, 10300, "o2x")
    val o2y by meshFloat(0.18f, 0.48f, 7600,  "o2y")
    val o3x by meshFloat(0.28f, 0.58f, 11200, "o3x")
    val o3y by meshFloat(0.62f, 0.88f, 8700,  "o3y")
    val o4x by meshFloat(0.82f, 0.52f, 9600,  "o4x")
    val o4y by meshFloat(0.74f, 0.44f, 12100, "o4y")

    val a1 = if (c.isDark) 0.24f else 0.12f
    val a2 = if (c.isDark) 0.18f else 0.09f
    val a3 = if (c.isDark) 0.16f else 0.08f
    val a4 = if (c.isDark) 0.13f else 0.06f

    Canvas(modifier = modifier.fillMaxSize()) {
        val w = size.width
        val h = size.height
        listOf(
            Triple(c.primary,    Offset(w * o1x, h * o1y), a1),
            Triple(c.secondary,  Offset(w * o2x, h * o2y), a2),
            Triple(c.accent,     Offset(w * o3x, h * o3y), a3),
            Triple(c.tertiary,   Offset(w * o4x, h * o4y), a4),
        ).forEach { (color, center, alpha) ->
            drawCircle(
                brush = Brush.radialGradient(
                    colors = listOf(color.copy(alpha = alpha), Color.Transparent),
                    center = center,
                    radius = w * 0.55f,
                ),
                radius = w * 0.55f,
                center = center,
            )
        }
    }
}
