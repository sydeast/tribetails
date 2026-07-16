package com.tribetails.auntieos.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
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
import androidx.compose.ui.draw.scale
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * AuntieSearchField. The Den pill search input.
 *
 * A single-line rounded "pill" text field with a leading magnifier, placeholder,
 * an optional clearable "x" affordance, and an optional shortcut-hint micro-pill
 * (for example a "/" or "Cmd K" reminder). Built on [BasicTextField] styled to the
 * Den so it carries no Material3 chrome.
 *
 * Color resolution always goes through [AuntieTheme.colors]; spacing through
 * [AuntieTheme.dims]; text styles through [AuntieTheme.typography]. The pill leans
 * into the brand primary on focus and hover (border tint plus a faint accent wash),
 * matching the warm-dark glass treatment of the rest of the kit.
 *
 * Visuals are built only from Box / Row / Canvas + foundation primitives. The single
 * Material3 piece allowed (and used) is [androidx.compose.material3.Text]. When no
 * [leadingIcon] is supplied the magnifier is drawn with [Canvas] so the component
 * never hardcodes an [ImageVector] glyph; a caller-supplied [leadingIcon] is rendered
 * via a foundation [Image] vector painter instead.
 *
 * @param value         current query text.
 * @param onValueChange tap-by-tap query updates.
 * @param modifier      external layout modifier (width, etc.).
 * @param placeholder   faint hint shown while [value] is empty.
 * @param leadingIcon   optional caller-supplied leading glyph. Null draws the magnifier.
 * @param shortcutHint  optional trailing micro-pill (a keyboard shortcut reminder).
 *                      Hidden once the field has focus or any text is entered.
 * @param onClear       optional clear handler. Non-null shows an "x" once [value] is
 *                      non-empty; tapping it invokes [onClear] (callers typically reset
 *                      [value] to "" inside it).
 * @param onSubmit      optional submit handler fired on the IME search action.
 * @param enabled       disabled fields dim text and drop hover/focus affordances.
 */
@Composable
fun AuntieSearchField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "Search...",
    leadingIcon: ImageVector? = null,
    shortcutHint: String? = null,
    onClear: (() -> Unit)? = null,
    onSubmit: (() -> Unit)? = null,
    enabled: Boolean = true,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val typo = AuntieTheme.typography

    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    var focused by remember { mutableStateOf(false) }
    val active = (focused || hovered) && enabled

    // Container leans into the brand primary on focus first, then hover. A faint
    // accent wash composites over the glass surface so the pill warms as it wakes.
    val targetFill = when {
        !enabled -> c.surface2.copy(alpha = 0.5f)
        focused  -> c.surface
        hovered  -> c.surface2
        else     -> c.surfaceGlass
    }
    val targetBorder = when {
        !enabled -> c.borderSoft
        focused  -> c.primary.copy(alpha = 0.6f)
        hovered  -> c.primary.copy(alpha = 0.4f)
        else     -> c.border
    }
    // The leading glyph and placeholder dim when idle and warm to primary on focus.
    val targetGlyph = when {
        !enabled -> c.textFaint
        focused  -> c.primary
        else     -> c.textDim
    }

    val fill by animateColorAsState(targetFill, animationSpec = tween(160), label = "searchFill")
    val borderColor by animateColorAsState(targetBorder, animationSpec = tween(160), label = "searchBorder")
    val glyphColor by animateColorAsState(targetGlyph, animationSpec = tween(160), label = "searchGlyph")

    // The leading magnifier nudges a touch larger as the field wakes. Den whimsy.
    val glyphScale by animateFloatAsState(
        targetValue   = if (active) 1.06f else 1f,
        animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
        label         = "searchGlyphScale",
    )

    val shape = RoundedCornerShape(999.dp)
    val showClear = onClear != null && value.isNotEmpty() && enabled
    // The hint reminds you of the shortcut at rest; once you commit to the field
    // (focus or typed text) it gets out of the way.
    val showHint = shortcutHint != null && value.isEmpty() && !focused && enabled

    Row(
        modifier = modifier
            .height(42.dp)
            .clip(shape)
            .background(fill)
            .border(BorderStroke(dims.borderHairline, SolidColor(borderColor)), shape)
            .padding(start = dims.space4, end = dims.space2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(dims.space2),
    ) {
        // ── Leading glyph: caller vector painter, or the drawn magnifier ──────
        Box(
            modifier = Modifier
                .size(18.dp)
                .scale(glyphScale),
            contentAlignment = Alignment.Center,
        ) {
            if (leadingIcon != null) {
                Image(
                    painter = rememberVectorPainter(leadingIcon),
                    contentDescription = null,
                    colorFilter = ColorFilter.tint(glyphColor),
                    modifier = Modifier.requiredSize(18.dp),
                )
            } else {
                MagnifierGlyph(tint = glyphColor)
            }
        }

        // ── The text field itself ────────────────────────────────────────────
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            enabled = enabled,
            singleLine = true,
            cursorBrush = SolidColor(c.primary),
            textStyle = typo.bodyMedium.copy(color = if (enabled) c.textPrimary else c.textFaint),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { onSubmit?.invoke() }),
            interactionSource = interaction,
            modifier = Modifier
                .weight(1f)
                .onFocusChanged { focused = it.isFocused },
            decorationBox = { inner ->
                Box(contentAlignment = Alignment.CenterStart) {
                    if (value.isEmpty()) {
                        Text(
                            text = placeholder,
                            style = typo.bodyMedium,
                            color = c.textFaint,
                        )
                    }
                    inner()
                }
            },
        )

        // ── Trailing shortcut-hint pill (mono / uppercase) ────────────────────
        AnimatedVisibility(
            visible = showHint,
            enter = fadeIn(tween(140)),
            exit = fadeOut(tween(100)),
        ) {
            ShortcutHintPill(text = shortcutHint ?: "")
        }

        // ── Trailing clear affordance ─────────────────────────────────────────
        AnimatedVisibility(
            visible = showClear,
            enter = fadeIn(tween(140)) + scaleIn(tween(140), initialScale = 0.7f),
            exit = fadeOut(tween(100)) + scaleOut(tween(100), targetScale = 0.7f),
        ) {
            ClearGlyph(tint = c.textDim, onClear = { onClear?.invoke() })
        }
    }
}

// ── Internal glyphs (drawn, no M3 icons) ────────────────────────────────────────

/** Magnifier drawn with Canvas: a circle lens plus a short handle stroke. */
@Composable
private fun MagnifierGlyph(tint: Color) {
    Canvas(modifier = Modifier.size(18.dp)) {
        val w = size.width
        val stroke = w * 0.12f
        val lensRadius = w * 0.32f
        val lensCenter = Offset(w * 0.42f, w * 0.42f)
        drawCircle(
            color = tint,
            radius = lensRadius,
            center = lensCenter,
            style = Stroke(width = stroke),
        )
        // Handle: from the lower-right edge of the lens out toward the corner.
        val edge = Offset(
            x = lensCenter.x + lensRadius * 0.7071f,
            y = lensCenter.y + lensRadius * 0.7071f,
        )
        drawLine(
            color = tint,
            start = edge,
            end = Offset(w * 0.86f, w * 0.86f),
            strokeWidth = stroke,
        )
    }
}

/** Trailing mono micro-pill that reminds the user of a keyboard shortcut. */
@Composable
private fun ShortcutHintPill(text: String) {
    val c = AuntieTheme.colors
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(c.surface2.copy(alpha = 0.7f))
            .border(AuntieTheme.dims.borderHairline, c.borderSoft, RoundedCornerShape(6.dp))
            .padding(horizontal = 7.dp, vertical = 2.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text.uppercase(),
            style = AuntieTheme.typography.mono.copy(fontWeight = FontWeight.Medium),
            color = c.textDim,
        )
    }
}

/** Clearable "x" affordance with its own hit target + hover (mirrors AuntieChip). */
@Composable
private fun ClearGlyph(tint: Color, onClear: () -> Unit) {
    val c = AuntieTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    val bg by animateColorAsState(
        if (hovered) c.surface2 else Color.Transparent,
        animationSpec = tween(140),
        label = "searchClearBg",
    )
    val glyph by animateColorAsState(
        if (hovered) c.textPrimary else tint,
        animationSpec = tween(140),
        label = "searchClearGlyph",
    )
    Box(
        modifier = Modifier
            .size(26.dp)
            .clip(CircleShape)
            .background(bg)
            .clickable(
                interactionSource = interaction,
                indication = null,
                onClick = onClear,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(modifier = Modifier.size(9.dp)) {
            val s = size.width
            val strokeWidth = s * 0.18f
            drawLine(
                color = glyph,
                start = Offset(0f, 0f),
                end = Offset(s, s),
                strokeWidth = strokeWidth,
            )
            drawLine(
                color = glyph,
                start = Offset(s, 0f),
                end = Offset(0f, s),
                strokeWidth = strokeWidth,
            )
        }
    }
}
