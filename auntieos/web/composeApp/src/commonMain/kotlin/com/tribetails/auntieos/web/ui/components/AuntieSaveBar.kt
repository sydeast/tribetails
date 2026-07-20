package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * AuntieSaveBar
 *
 * Sticky footer action bar for editor screens. A leading dirty pip plus a mono
 * status label sits on the left; trailing Cancel (ghost) and primary Save sit on
 * the right. Save is disabled whenever [saveEnabled] is false (for example, while
 * required fields are invalid), so an enabled-but-not-dirty state can still read
 * "Save changes" without letting the operator commit an unsaved-but-invalid form.
 *
 * Visuals follow the Den kit: frosted glass surface, a top hairline border that
 * lifts the bar off the scrolling content, a brand-gold dirty pip that gently
 * pulses while [dirty] is true, and a Spline-mono uppercase status label.
 *
 * Build-from-primitives only (Box/Row/Canvas + foundation); reuses the existing
 * [PrimaryButton] and [GhostButton] for the trailing actions.
 */
@Composable
fun AuntieSaveBar(
    dirty: Boolean,
    saveEnabled: Boolean,
    onCancel: () -> Unit,
    onSave: () -> Unit,
    modifier: Modifier = Modifier,
    saveLabel: String = "Save changes",
    cancelLabel: String = "Cancel",
    dirtyLabel: String = "Unsaved changes",
    savedLabel: String = "All changes saved",
) {
    val c = AuntieTheme.colors

    // Pip color: brand gold while dirty, faint when clean.
    val pipColor = if (dirty) c.primary else c.textFaint

    // Gentle breathing pulse for the dirty pip so it reads as "live, pending".
    val transition = rememberInfiniteTransition(label = "saveBarPip")
    val pulse by transition.animateFloat(
        initialValue = if (dirty) 0.45f else 1f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 900),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "saveBarPipPulse",
    )
    val pipAlpha = if (dirty) pulse else 1f
    val hairline = AuntieTheme.dims.borderHairline

    Box(
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = AuntieTheme.dims.bottomDockHeight)
            // Frosted footer: glass fill + a single top hairline border so the bar
            // visually separates from the content scrolling beneath it.
            .background(c.surfaceGlass)
            .drawBehind {
                drawLine(
                    brush = SolidColor(c.border),
                    start = Offset(0f, 0f),
                    end = Offset(size.width, 0f),
                    strokeWidth = hairline.toPx(),
                )
            }
            .padding(
                horizontal = AuntieTheme.dims.space6,
                vertical = AuntieTheme.dims.space4,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space4),
        ) {
            // --- Leading: dirty pip + mono status label ---
            Row(
                modifier = Modifier.weight(1f),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space3),
            ) {
                Canvas(modifier = Modifier.size(10.dp)) {
                    val r = size.minDimension / 2f
                    // Soft halo when dirty for a touch of Den whimsy.
                    if (dirty) {
                        drawCircle(
                            color = pipColor.copy(alpha = 0.22f * pipAlpha),
                            radius = r,
                            center = Offset(size.width / 2f, size.height / 2f),
                        )
                    }
                    drawCircle(
                        color = pipColor.copy(alpha = pipAlpha),
                        radius = if (dirty) r * 0.62f else r * 0.5f,
                        center = Offset(size.width / 2f, size.height / 2f),
                    )
                }
                Text(
                    text = (if (dirty) dirtyLabel else savedLabel).uppercase(),
                    style = AuntieTheme.typography.mono,
                    color = if (dirty) c.textPrimary else c.textDim,
                )
            }

            // --- Trailing: Cancel (ghost) + Save (primary) ---
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(AuntieTheme.dims.space3),
            ) {
                GhostButton(
                    label = cancelLabel,
                    onClick = onCancel,
                )
                PrimaryButton(
                    label = saveLabel,
                    onClick = onSave,
                    enabled = saveEnabled,
                )
            }
        }
    }
}
