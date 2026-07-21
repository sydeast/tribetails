package com.tribetails.auntieos.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * Password input in the Den style. Mirrors [BottomBorderField] (bottom-border-only
 * treatment, focus glow, hairline rule) but masks the value with a
 * [PasswordVisualTransformation] and exposes an in-field reveal toggle that flips
 * the mask on and off.
 *
 * The reveal control is drawn with Canvas (an eye outline plus a slash when masked)
 * so no specific Material icon is hardcoded and no Material3 visual component is used.
 * It hover-tints like the rest of the Den affordances.
 *
 * Only [androidx.compose.material3.Text] is borrowed from Material3; everything else
 * is built from Box / Row / Column / foundation drawing primitives.
 */
@Composable
fun AuntiePasswordField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    enabled: Boolean = true,
    isError: Boolean = false,
    imeAction: ImeAction = ImeAction.Done,
    initiallyRevealed: Boolean = false,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    val focusRequester = remember { FocusRequester() }
    val tapSource = remember { MutableInteractionSource() }
    var focused by remember { mutableStateOf(false) }
    var revealed by remember { mutableStateOf(initiallyRevealed) }

    val borderColor = animateColorAsState(
        when {
            isError -> c.error
            focused -> c.primary
            else    -> c.border
        },
        label = "passwordBorder",
    ).value
    val lineWidth by animateFloatAsState(
        targetValue   = if (focused) 1.5f else 0.5f,
        animationSpec = spring(stiffness = Spring.StiffnessMedium),
        label         = "passwordLineWidth",
    )
    val glowAlpha by animateFloatAsState(
        targetValue   = if (focused) 0.3f else 0f,
        animationSpec = tween(250),
        label         = "passwordLineGlow",
    )

    val visualTransformation: VisualTransformation =
        if (revealed) VisualTransformation.None else PasswordVisualTransformation()

    Column(modifier = modifier) {
        Text(
            text  = label.uppercase(),
            style = AuntieTheme.typography.labelSmall,
            color = when {
                isError -> c.error
                focused -> c.primary
                else    -> c.textDim
            },
            modifier = Modifier.padding(bottom = 6.dp),
        )
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(36.dp)
                // Forward taps anywhere inside the field row to the inner
                // BasicTextField (matches BottomBorderField's tap-forwarding fix).
                .clickable(
                    interactionSource = tapSource,
                    indication = null,
                    enabled = enabled,
                    onClick = { focusRequester.requestFocus() },
                )
                .drawBehind {
                    val y = size.height - 1.dp.toPx()
                    if (glowAlpha > 0f) {
                        drawRect(
                            brush = Brush.verticalGradient(
                                colors = listOf(Color.Transparent, c.primary.copy(alpha = glowAlpha)),
                                startY = y - 4.dp.toPx(),
                                endY   = y,
                            ),
                            topLeft = Offset(0f, y - 4.dp.toPx()),
                            size    = Size(size.width, 4.dp.toPx()),
                        )
                    }
                    drawLine(
                        color       = borderColor,
                        start       = Offset(0f, y),
                        end         = Offset(size.width, y),
                        strokeWidth = lineWidth,
                    )
                }
                .padding(vertical = 8.dp),
            contentAlignment = Alignment.CenterStart,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                BasicTextField(
                    value          = value,
                    onValueChange  = onValueChange,
                    enabled        = enabled,
                    singleLine     = true,
                    visualTransformation = visualTransformation,
                    cursorBrush    = SolidColor(c.primary),
                    textStyle      = AuntieTheme.typography.bodyMedium.copy(color = c.textPrimary),
                    keyboardOptions = KeyboardOptions(
                        keyboardType = KeyboardType.Password,
                        imeAction    = imeAction,
                    ),
                    modifier = Modifier
                        .weight(1f)
                        .focusRequester(focusRequester)
                        .onFocusChanged { focused = it.isFocused },
                    decorationBox = { inner ->
                        Box(contentAlignment = Alignment.CenterStart) {
                            if (value.isEmpty()) {
                                Text(
                                    text  = placeholder,
                                    style = AuntieTheme.typography.bodyMedium,
                                    color = c.textFaint,
                                )
                            }
                            inner()
                        }
                    },
                )
                RevealToggle(
                    revealed = revealed,
                    enabled  = enabled,
                    isError  = isError,
                    onToggle = { revealed = !revealed },
                    modifier = Modifier.padding(start = dims.space2),
                )
            }
        }
    }
}

/**
 * In-field show / hide control. Draws an eye outline (an almond shape plus a
 * pupil) with Canvas, overlaid by a diagonal slash when the value is masked,
 * so no Material icon is hardcoded. Tints toward the brand accent on hover.
 */
@Composable
private fun RevealToggle(
    revealed: Boolean,
    enabled: Boolean,
    isError: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    val active = hovered && enabled

    val accent = if (isError) c.error else c.primary

    val glyphColor = animateColorAsState(
        when {
            !enabled -> c.textFaint
            active   -> accent
            else     -> c.textDim
        },
        animationSpec = tween(160),
        label = "revealGlyph",
    ).value
    val bgColor = animateColorAsState(
        if (active) accent.copy(alpha = if (c.isDark) 0.18f else 0.12f) else Color.Transparent,
        animationSpec = tween(160),
        label = "revealBg",
    ).value

    val strokeWidthDp = dims.borderEmphasis
    val description = if (revealed) "Hide password" else "Show password"

    Box(
        modifier = modifier
            .size(28.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(bgColor)
            .clickable(
                interactionSource = interaction,
                indication = null,
                enabled = enabled,
                onClick = onToggle,
            )
            .semantics { contentDescription = description }
            .drawBehind {
                val w = strokeWidthDp.toPx()
                val cx = size.width / 2f
                val cy = size.height / 2f
                val halfW = 7.dp.toPx()
                val lid = 4.dp.toPx()

                // Upper lid: a shallow arc approximated with a quadratic curve.
                val upper = Path().apply {
                    moveTo(cx - halfW, cy)
                    quadraticTo(cx, cy - lid, cx + halfW, cy)
                }
                // Lower lid: mirror of the upper lid.
                val lower = Path().apply {
                    moveTo(cx - halfW, cy)
                    quadraticTo(cx, cy + lid, cx + halfW, cy)
                }
                drawPath(path = upper, color = glyphColor, style = Stroke(width = w))
                drawPath(path = lower, color = glyphColor, style = Stroke(width = w))

                // Pupil.
                drawCircle(
                    color  = glyphColor,
                    radius = 1.6.dp.toPx(),
                    center = Offset(cx, cy),
                )

                // Slash overlay when the value is masked (eye "off").
                if (!revealed) {
                    drawLine(
                        color = glyphColor,
                        start = Offset(cx - halfW, cy - lid - 1.dp.toPx()),
                        end   = Offset(cx + halfW, cy + lid + 1.dp.toPx()),
                        strokeWidth = w,
                    )
                }
            },
    )
}
