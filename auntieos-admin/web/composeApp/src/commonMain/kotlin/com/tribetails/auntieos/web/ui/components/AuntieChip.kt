package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * AuntieChip. The consolidated Den pill.
 *
 * One component covers every selectable / labeled pill in the kit:
 *   - Filter chip:        selectable, single tap toggles [selected]
 *   - Choice chip:        same, driven by an [AuntieChipGroup] for single/multi select
 *   - Token chip:         pass [onRemove] for a clearable "x" affordance (tags, recipients)
 *   - Two-line option:    pass [secondaryLabel] for a selectable option card with a subtitle
 *
 * Visuals are built only from Box / Row / Column / Canvas + foundation primitives.
 * The single Material3 piece allowed (and used) is [androidx.compose.material3.Text].
 *
 * Color resolution always goes through [AuntieTheme.colors] and the shared
 * [AuntieChipTone.accent] resolver, so every chip lands on the brand palette.
 *
 * @param label         primary label text.
 * @param selected      selected / active state (filter + choice modes).
 * @param onClick       tap handler. Null renders a non-interactive (display-only) chip.
 * @param enabled       disabled chips dim text + drop hover/press affordances.
 * @param leading       optional leading slot (icon, swatch, tiny avatar). Caller-supplied.
 * @param trailingTag   optional trailing micro-pill (count, shortcut, unit). Mono-styled.
 * @param secondaryLabel optional second line. Promotes the chip to a two-line option card.
 * @param onRemove      optional remove handler. Renders a clearable "x" token affordance.
 * @param tone          brand tone resolved via [AuntieChipTone.accent].
 * @param mono          render the primary label in the Spline mono / uppercase style.
 */
@Composable
fun AuntieChip(
    label: String,
    modifier: Modifier = Modifier,
    selected: Boolean = false,
    onClick: (() -> Unit)? = null,
    enabled: Boolean = true,
    leading: (@Composable () -> Unit)? = null,
    trailingTag: String? = null,
    secondaryLabel: String? = null,
    onRemove: (() -> Unit)? = null,
    tone: AuntieChipTone = AuntieChipTone.Neutral,
    mono: Boolean = false,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val typo = AuntieTheme.typography
    val accent = tone.accent(c)

    val twoLine = secondaryLabel != null
    val clickable = onClick != null && enabled

    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    val showHover = hovered && clickable

    // Resolve container colors. Selected uses a tinted accent wash; resting uses glass.
    val targetFill = when {
        !enabled         -> c.surface2.copy(alpha = 0.5f)
        selected         -> accent.copy(alpha = if (c.isDark) 0.22f else 0.14f).compositeOver(c.surface)
        showHover        -> c.surface2
        else             -> c.surfaceGlass
    }
    val targetBorder = when {
        !enabled  -> c.borderSoft
        selected  -> accent.copy(alpha = 0.55f)
        showHover -> accent.copy(alpha = 0.45f)
        else      -> c.border
    }
    val targetLabel = when {
        !enabled -> c.textFaint
        selected -> if (tone == AuntieChipTone.Neutral) c.textPrimary else accent
        else     -> c.textPrimary
    }

    val fill by animateColorAsState(targetFill, label = "chipFill")
    val borderColor by animateColorAsState(targetBorder, label = "chipBorder")
    val labelColor by animateColorAsState(targetLabel, label = "chipLabel")

    // Gentle press/hover spring on the whole pill. Matches Den whimsy without bounce overkill.
    val pressScale by animateFloatAsState(
        targetValue   = if (showHover) 1.02f else 1f,
        animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
        label         = "chipScale",
    )

    val shape = if (twoLine) RoundedCornerShape(14.dp) else RoundedCornerShape(999.dp)

    var container = modifier
        .scale(pressScale)
        .clip(shape)
        .background(fill)
        .border(BorderStroke(dims.borderHairline, SolidColor(borderColor)), shape)
    if (clickable) {
        container = container.clickable(
            interactionSource = interaction,
            indication = null,
            onClick = { onClick?.invoke() },
        )
    }

    if (twoLine) {
        // ── Two-line selectable option card ─────────────────────────────
        Row(
            modifier = container.padding(horizontal = dims.space4, vertical = dims.space3),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(dims.space3),
        ) {
            if (leading != null) {
                Box(contentAlignment = Alignment.Center) { leading() }
            }
            Column(
                modifier = Modifier,
                verticalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Text(
                    text = label,
                    style = if (mono) {
                        typo.mono.copy(fontWeight = FontWeight.Medium)
                    } else {
                        typo.titleSmall
                    },
                    color = labelColor,
                )
                Text(
                    text = secondaryLabel,
                    style = typo.bodySmall,
                    color = if (enabled) c.textDim else c.textFaint,
                )
            }
            trailingTag?.let { TrailingTag(it, accent, enabled) }
            if (selected && onRemove == null) {
                CheckGlyph(accent = if (enabled) accent else c.textFaint)
            }
            onRemove?.let { RemoveGlyph(tint = labelColor, enabled = enabled, onRemove = it) }
        }
    } else {
        // ── Single-line filter / choice / token chip ────────────────────
        Row(
            modifier = container.padding(
                start = if (leading != null) dims.space3 else dims.space4,
                end = if (onRemove != null) dims.space2 else dims.space4,
                top = dims.space2,
                bottom = dims.space2,
            ),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(dims.space2),
        ) {
            leading?.let { Box(contentAlignment = Alignment.Center) { it() } }
            Text(
                text = if (mono) label.uppercase() else label,
                style = if (mono) {
                    typo.mono.copy(fontWeight = FontWeight.Medium)
                } else {
                    typo.labelLarge
                },
                color = labelColor,
            )
            trailingTag?.let { TrailingTag(it, accent, enabled) }
            onRemove?.let { RemoveGlyph(tint = labelColor, enabled = enabled, onRemove = it) }
        }
    }
}

// AuntieChipGroup lives in AuntieChipGroup.kt (canonical, fuller API).

// ── Internal glyphs (drawn, no M3 icons) ───────────────────────────────────────

/** Trailing micro-pill: count / shortcut / unit. Always mono. */
@Composable
private fun TrailingTag(text: String, accent: Color, enabled: Boolean) {
    val c = AuntieTheme.colors
    Box(
        modifier = Modifier
            .clip(RoundedCornerShape(999.dp))
            .background((if (enabled) accent else c.textFaint).copy(alpha = 0.16f))
            .padding(horizontal = 6.dp, vertical = 1.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            style = AuntieTheme.typography.mono.copy(fontSize = 11.sp, fontWeight = FontWeight.Medium),
            color = if (enabled) accent else c.textFaint,
        )
    }
}

/** Checkmark drawn with Canvas (marks a selected two-line option). */
@Composable
private fun CheckGlyph(accent: Color) {
    Canvas(modifier = Modifier.size(16.dp)) {
        val w = size.width
        val h = size.height
        val stroke = Stroke(width = w * 0.14f)
        val path = Path().apply {
            moveTo(w * 0.2f, h * 0.55f)
            lineTo(w * 0.42f, h * 0.76f)
            lineTo(w * 0.82f, h * 0.28f)
        }
        drawPath(path = path, color = accent, style = stroke)
    }
}

/** Clearable "x" affordance for token chips. Its own tiny hit target + hover. */
@Composable
private fun RemoveGlyph(tint: Color, enabled: Boolean, onRemove: () -> Unit) {
    val c = AuntieTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val hovered by interaction.collectIsHoveredAsState()
    val bg by animateColorAsState(
        if (hovered && enabled) c.error.copy(alpha = 0.18f) else Color.Transparent,
        label = "removeBg",
    )
    val glyph by animateColorAsState(
        when {
            !enabled -> c.textFaint
            hovered  -> c.error
            else     -> tint
        },
        label = "removeGlyph",
    )
    Box(
        modifier = Modifier
            .size(18.dp)
            .clip(CircleShape)
            .background(bg)
            .clickable(
                interactionSource = interaction,
                indication = null,
                enabled = enabled,
                onClick = onRemove,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(modifier = Modifier.size(8.dp)) {
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
