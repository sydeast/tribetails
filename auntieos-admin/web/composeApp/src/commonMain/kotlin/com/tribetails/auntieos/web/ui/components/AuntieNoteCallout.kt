package com.tribetails.auntieos.web.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * AuntieNoteCallout - read-only display callout for free-text notes.
 *
 * Den aesthetic: a soft glass panel with an optional dashed brand-tinted border
 * and muted italic body text. Use it to surface kinfolk-facing or admin-internal
 * notes that have already been saved (it is display-only, never an input). For an
 * editable note box use [MultilineField] instead.
 *
 * The dashed treatment is drawn on a Canvas (drawBehind) with a dash [PathEffect]
 * so it stays crisp on Wasm. When [dashed] is false a solid hairline border is
 * used instead, matching the rest of the Den component kit.
 */
@Composable
fun AuntieNoteCallout(
    text: String,
    modifier: Modifier = Modifier,
    dashed: Boolean = true,
    italic: Boolean = true,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val shape = RoundedCornerShape(10.dp)

    // Brand-tinted, low-emphasis border so the callout reads as a quiet aside,
    // not a hard-edged field. Falls back to the standard hairline border tone.
    val borderColor = c.border

    Box(
        modifier = modifier
            .fillMaxWidth()
            .background(c.surfaceGlass, shape)
            .then(
                if (dashed) {
                    Modifier.drawBehind {
                        val strokePx = dims.borderHairline.toPx().coerceAtLeast(1f)
                        val dashOn = 4.dp.toPx()
                        val dashOff = 4.dp.toPx()
                        val radius = 10.dp.toPx()
                        val inset = strokePx / 2f
                        drawRoundRect(
                            color = borderColor,
                            topLeft = Offset(inset, inset),
                            size = Size(size.width - strokePx, size.height - strokePx),
                            cornerRadius = CornerRadius(radius, radius),
                            style = Stroke(
                                width = strokePx,
                                pathEffect = PathEffect.dashPathEffect(
                                    intervals = floatArrayOf(dashOn, dashOff),
                                    phase = 0f,
                                ),
                            ),
                        )
                    }
                } else {
                    Modifier.border(dims.borderHairline, borderColor, shape)
                },
            )
            .padding(horizontal = dims.space4, vertical = dims.space3),
    ) {
        Text(
            text = text,
            style = AuntieTheme.typography.bodyMedium.copy(
                fontStyle = if (italic) FontStyle.Italic else FontStyle.Normal,
            ),
            color = c.textDim,
        )
    }
}
