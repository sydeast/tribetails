package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * Den-styled single-value dropdown. Wraps the ALLOWED Material3 [DropdownMenu]
 * for the popup, but renders the trigger and menu rows from foundation
 * primitives + Canvas so the warm-dark Den aesthetic is preserved (glass
 * surface, hairline border, hover-driven accent border, hand-drawn caret +
 * check mark instead of M3 icons).
 *
 * Optional uppercase Spline-mono-style [label] sits above the trigger with an
 * orange required marker when [required] is true.
 *
 * @param T          the option value type.
 * @param label      uppercase field label; pass an empty string to hide it.
 * @param options    selectable values, rendered in order.
 * @param selected   the currently selected value (shown in the trigger).
 * @param onSelect   invoked with the chosen value when a row is tapped.
 * @param optionLabel maps a value to its human-readable text. Defaults to toString().
 * @param required   when true, shows an accent "*" after the label.
 * @param enabled    when false, the trigger is dimmed and not interactive.
 */
@Composable
fun <T> AuntieSelectField(
    label: String,
    options: List<T>,
    selected: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    optionLabel: (T) -> String = { it.toString() },
    required: Boolean = false,
    enabled: Boolean = true,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val typo = AuntieTheme.typography
    val shape = RoundedCornerShape(8.dp)

    var expanded by remember { mutableStateOf(false) }
    val interaction = remember { MutableInteractionSource() }
    val hovered = interaction.collectIsHoveredAsState().value
    val active = (hovered || expanded) && enabled

    val borderColor = animateColorAsState(
        when {
            !enabled -> c.borderSoft
            active   -> c.primary
            else     -> c.border
        },
        label = "selectBorder",
    ).value

    val valueColor = animateColorAsState(
        if (enabled) c.textPrimary else c.textFaint,
        label = "selectValue",
    ).value

    val caretColor = animateColorAsState(
        when {
            !enabled -> c.textFaint
            active   -> c.primary
            else     -> c.textDim
        },
        label = "selectCaret",
    ).value

    val caretRotation by animateFloatAsState(
        targetValue = if (expanded) 180f else 0f,
        animationSpec = spring(stiffness = Spring.StiffnessMedium),
        label = "selectCaretRotation",
    )

    Column(modifier = modifier) {
        if (label.isNotEmpty()) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(bottom = 6.dp),
            ) {
                Text(
                    text = label.uppercase(),
                    style = typo.labelSmall,
                    color = if (enabled) c.textDim else c.textFaint,
                )
                if (required) {
                    Text(
                        text = " *",
                        style = typo.labelSmall,
                        color = c.primary,
                    )
                }
            }
        }

        Box {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(40.dp)
                    .clip(shape)
                    .background(c.surfaceGlass)
                    .border(dims.borderHairline, borderColor, shape)
                    .clickable(
                        enabled = enabled,
                        interactionSource = interaction,
                        indication = null,
                        onClick = { expanded = true },
                    )
                    .padding(horizontal = dims.space4),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(dims.space2),
            ) {
                Text(
                    text = optionLabel(selected),
                    style = typo.bodyMedium,
                    color = valueColor,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Chevron(
                    color = caretColor,
                    modifier = Modifier
                        .size(14.dp)
                        .rotate(caretRotation),
                )
            }

            DropdownMenu(
                expanded = expanded,
                onDismissRequest = { expanded = false },
            ) {
                options.forEach { opt ->
                    val isSelected = opt == selected
                    DropdownMenuItem(
                        text = {
                            Text(
                                text = optionLabel(opt),
                                style = typo.bodyMedium,
                                color = if (isSelected) c.primary else c.textPrimary,
                            )
                        },
                        leadingIcon = {
                            Box(
                                modifier = Modifier.size(16.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                if (isSelected) {
                                    CheckMark(
                                        color = c.primary,
                                        modifier = Modifier.size(14.dp),
                                    )
                                }
                            }
                        },
                        onClick = {
                            onSelect(opt)
                            expanded = false
                        },
                    )
                }
            }
        }
    }
}

/** Hand-drawn downward chevron so we avoid M3 Icon. Rotate 180 to flip. */
@Composable
private fun Chevron(
    color: androidx.compose.ui.graphics.Color,
    modifier: Modifier = Modifier,
) {
    androidx.compose.foundation.Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height
        val strokeW = 1.6.dp.toPx()
        val topY = h * 0.36f
        val botY = h * 0.62f
        // Left arm
        drawLine(
            color = color,
            start = Offset(w * 0.22f, topY),
            end = Offset(w * 0.5f, botY),
            strokeWidth = strokeW,
            cap = StrokeCap.Round,
        )
        // Right arm
        drawLine(
            color = color,
            start = Offset(w * 0.78f, topY),
            end = Offset(w * 0.5f, botY),
            strokeWidth = strokeW,
            cap = StrokeCap.Round,
        )
    }
}

/** Hand-drawn check mark so we avoid M3 Icon for the selected-row marker. */
@Composable
private fun CheckMark(
    color: androidx.compose.ui.graphics.Color,
    modifier: Modifier = Modifier,
) {
    androidx.compose.foundation.Canvas(modifier = modifier) {
        val w = size.width
        val h = size.height
        val strokeW = 1.8.dp.toPx()
        drawLine(
            color = color,
            start = Offset(w * 0.18f, h * 0.52f),
            end = Offset(w * 0.42f, h * 0.76f),
            strokeWidth = strokeW,
            cap = StrokeCap.Round,
        )
        drawLine(
            color = color,
            start = Offset(w * 0.42f, h * 0.76f),
            end = Offset(w * 0.82f, h * 0.28f),
            strokeWidth = strokeW,
            cap = StrokeCap.Round,
        )
    }
}
