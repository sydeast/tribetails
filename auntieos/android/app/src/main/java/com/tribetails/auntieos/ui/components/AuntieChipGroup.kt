package com.tribetails.auntieos.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.material3.Text
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * AuntieChipGroup: wrapping flow layout that arranges a row of selectable chips.
 *
 * Selection is driven entirely by the caller: pass the full [options] list, the
 * currently [selected] set, and an [onSelectionChange] callback that receives the
 * next set. The component never mutates state itself, so it slots into any
 * unidirectional-data-flow screen.
 *
 *  - [singleSelect] = false (default): multi-select. Tapping a chip toggles it in
 *    or out of the set.
 *  - [singleSelect] = true: radio semantics. Tapping a chip replaces the set with
 *    just that chip. Tapping the already-selected chip clears it only when
 *    [clearable] is true, otherwise the selection is left as-is.
 *
 * When [clearable] is true and the selection is non-empty, a trailing "Clear"
 * chip is appended that empties the set.
 *
 * When [onAddCustom] is supplied, a trailing dashed "add" chip is appended that
 * invokes the callback (for example to open a text field that adds a custom
 * option). The plus glyph is drawn with a foundation Canvas, not a Material icon,
 * keeping the chip inside the Den component kit.
 *
 * Visuals follow the Den standard: pill-shaped glass surfaces, a hairline border,
 * hover lift via MutableInteractionSource + collectIsHoveredAsState +
 * animateColorAsState, the Hanken label style, and the Spline mono style for the
 * optional [monoSuffix] (counts, codes, units). Selected chips wash the brand
 * accent over the glass. None of the colors, spacing, or text styles are
 * hardcoded; they all resolve through AuntieTheme.
 *
 * @param options      Every chip to render, in display order.
 * @param selected     The set of options currently selected.
 * @param onSelectionChange  Called with the next selection set on every change.
 * @param label        Maps an option to its human-readable chip label.
 * @param singleSelect Radio (true) vs. multi-select (false) semantics.
 * @param clearable    Append a "Clear" chip while the selection is non-empty.
 * @param enabled      Per-option enabled predicate. Disabled chips are dimmed and
 *                     do not respond to taps.
 * @param monoSuffix   Optional trailing mono token shown after the label (counts,
 *                     short codes). Return null to omit it for that option.
 * @param onAddCustom  Optional trailing "add" affordance. Null hides it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun <T> AuntieChipGroup(
    options: List<T>,
    selected: Set<T>,
    onSelectionChange: (Set<T>) -> Unit,
    label: (T) -> String,
    modifier: Modifier = Modifier,
    singleSelect: Boolean = false,
    clearable: Boolean = false,
    enabled: (T) -> Boolean = { true },
    monoSuffix: (T) -> String? = { null },
    onAddCustom: (() -> Unit)? = null,
) {
    val dims = AuntieTheme.dims

    FlowRow(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(dims.space2),
        verticalArrangement = Arrangement.spacedBy(dims.space2),
    ) {
        options.forEach { option ->
            val isSelected = option in selected
            val isEnabled = enabled(option)
            ChipCell(
                label = label(option),
                monoSuffix = monoSuffix(option),
                selected = isSelected,
                enabled = isEnabled,
                onClick = {
                    val next: Set<T> = when {
                        singleSelect && isSelected ->
                            if (clearable) emptySet() else selected
                        singleSelect -> setOf(option)
                        isSelected -> selected - option
                        else -> selected + option
                    }
                    if (next != selected) onSelectionChange(next)
                },
            )
        }

        if (clearable && selected.isNotEmpty()) {
            ClearChipCell(onClick = { onSelectionChange(emptySet()) })
        }

        if (onAddCustom != null) {
            AddChipCell(onClick = onAddCustom)
        }
    }
}

/**
 * A single selectable chip. Selected chips wash the brand accent over the glass;
 * unselected chips sit on the glass surface with a hairline border that warms to
 * the accent on hover. Disabled chips are dimmed and inert.
 */
@Composable
private fun ChipCell(
    label: String,
    monoSuffix: String?,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val accent = AuntieChipTone.Accent.accent(c)

    val interaction = remember { MutableInteractionSource() }
    val hovered = interaction.collectIsHoveredAsState().value && enabled

    val borderColor = animateColorAsState(
        when {
            !enabled -> c.borderSoft
            selected -> accent.copy(alpha = 0.55f)
            hovered -> accent.copy(alpha = 0.45f)
            else -> c.border
        },
        animationSpec = tween(160),
        label = "chipBorder",
    ).value

    val washAlpha = if (c.isDark) 0.22f else 0.14f
    val fillColor = animateColorAsState(
        when {
            !enabled -> c.surfaceGlass.copy(alpha = 0.5f)
            selected -> accent.copy(alpha = washAlpha)
            hovered -> c.surface2
            else -> c.surfaceGlass
        },
        animationSpec = tween(160),
        label = "chipFill",
    ).value

    val labelColor = animateColorAsState(
        when {
            !enabled -> c.textFaint
            selected -> accent
            hovered -> c.textPrimary
            else -> c.textDim
        },
        animationSpec = tween(160),
        label = "chipLabel",
    ).value

    Row(
        modifier = Modifier
            .heightIn(min = 32.dp)
            .clip(AuntieTheme.shapes.pill)
            .background(fillColor)
            .border(dims.borderHairline, SolidColor(borderColor), AuntieTheme.shapes.pill)
            .clickable(
                enabled = enabled,
                interactionSource = interaction,
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = dims.space3, vertical = dims.space1),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(dims.space1),
    ) {
        Text(
            text = label,
            style = AuntieTheme.typography.labelMedium,
            color = labelColor,
        )
        if (!monoSuffix.isNullOrEmpty()) {
            Text(
                text = monoSuffix,
                style = AuntieTheme.typography.mono,
                color = if (enabled) labelColor.copy(alpha = 0.8f) else c.textFaint,
            )
        }
    }
}

/**
 * Trailing chip that empties the selection. Reads in the muted text tone and
 * warms to the brand primary on hover, matching the GhostButton convention.
 */
@Composable
private fun ClearChipCell(onClick: () -> Unit) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    val interaction = remember { MutableInteractionSource() }
    val hovered = interaction.collectIsHoveredAsState().value

    val borderColor = animateColorAsState(
        if (hovered) c.primary.copy(alpha = 0.45f) else c.border,
        animationSpec = tween(160),
        label = "clearBorder",
    ).value
    val labelColor = animateColorAsState(
        if (hovered) c.primary else c.textFaint,
        animationSpec = tween(160),
        label = "clearLabel",
    ).value

    Box(
        modifier = Modifier
            .heightIn(min = 32.dp)
            .clip(AuntieTheme.shapes.pill)
            .background(c.surfaceGlass)
            .border(dims.borderHairline, SolidColor(borderColor), AuntieTheme.shapes.pill)
            .clickable(
                interactionSource = interaction,
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = dims.space3, vertical = dims.space1),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = "Clear",
            style = AuntieTheme.typography.labelMedium,
            color = labelColor,
        )
    }
}

/**
 * Trailing "add custom" chip. The plus glyph is rendered with a foundation
 * Canvas (two stroked lines) rather than a Material icon, so the component pulls
 * in no icon dependency. The chip styles itself like a dashed-intent ghost
 * affordance that warms to the brand primary on hover.
 */
@Composable
private fun AddChipCell(onClick: () -> Unit) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    val interaction = remember { MutableInteractionSource() }
    val hovered = interaction.collectIsHoveredAsState().value

    val accentColor = animateColorAsState(
        if (hovered) c.primary else c.textDim,
        animationSpec = tween(160),
        label = "addAccent",
    ).value
    val borderColor = animateColorAsState(
        if (hovered) c.primary.copy(alpha = 0.5f) else c.border,
        animationSpec = tween(160),
        label = "addBorder",
    ).value
    val glyphAlpha by animateFloatAsState(
        targetValue = if (hovered) 1f else 0.85f,
        animationSpec = tween(160),
        label = "addGlyph",
    )

    Row(
        modifier = Modifier
            .heightIn(min = 32.dp)
            .clip(AuntieTheme.shapes.pill)
            .background(c.surfaceGlass)
            .border(dims.borderHairline, SolidColor(borderColor), AuntieTheme.shapes.pill)
            .clickable(
                interactionSource = interaction,
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = dims.space3, vertical = dims.space1),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(dims.space1),
    ) {
        Canvas(modifier = Modifier.size(12.dp)) {
            val stroke = 1.5.dp.toPx()
            val mid = size.minDimension / 2f
            val inset = stroke
            drawLine(
                color = accentColor.copy(alpha = glyphAlpha),
                start = Offset(mid, inset),
                end = Offset(mid, size.height - inset),
                strokeWidth = stroke,
                cap = StrokeCap.Round,
            )
            drawLine(
                color = accentColor.copy(alpha = glyphAlpha),
                start = Offset(inset, mid),
                end = Offset(size.width - inset, mid),
                strokeWidth = stroke,
                cap = StrokeCap.Round,
            )
        }
        Text(
            text = "Add",
            style = AuntieTheme.typography.labelMedium,
            color = accentColor,
        )
    }
}
