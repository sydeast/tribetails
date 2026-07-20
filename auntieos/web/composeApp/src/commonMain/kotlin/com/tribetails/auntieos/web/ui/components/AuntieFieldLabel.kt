package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsHoveredAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * AuntieFieldLabel
 *
 * Den form-field caption. Spline mono, uppercase, dimmed. Optional decorations:
 *   - required marker (a coral asterisk after the text),
 *   - inline helper note (lighter face, normal case, for "optional" hints),
 *   - numeric index (a small mono badge before the label, for ordered fields),
 *   - leading status dot (small solid circle, color supplied by caller),
 *   - right action link (mono uppercase, primary on hover, fires onAction).
 *
 * Visuals are built from Row / Spacer / Box-via-modifiers + the M3 Text
 * primitive only. Colors, spacing, and the mono face all resolve from
 * AuntieTheme so the label stays in lockstep with BottomBorderField and the
 * rest of the Den form kit.
 */
@Composable
fun AuntieFieldLabel(
    text: String,
    modifier: Modifier = Modifier,
    required: Boolean = false,
    optionalNote: String? = null,
    index: String? = null,
    dotColor: Color? = null,
    actionText: String? = null,
    onAction: (() -> Unit)? = null,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    // Shared mono caption face. Matches AuntieBreadcrumbs / AuntieKeyValueRow.
    val labelStyle = AuntieTheme.typography.mono.copy(
        fontSize = 11.sp,
        letterSpacing = 0.6.sp,
    )

    Row(
        modifier = modifier.padding(bottom = dims.space2),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(dims.space2),
    ) {
        // Leading numeric index badge, for ordered/stepped fields.
        if (index != null) {
            Text(
                text = index,
                style = labelStyle.copy(fontWeight = FontWeight.SemiBold),
                color = c.textFaint,
                modifier = Modifier
                    .clip(RoundedCornerShape(4.dp))
                    .background(c.surface2)
                    .padding(horizontal = dims.space2, vertical = dims.space1),
            )
        }

        // Leading status dot, color supplied by caller (e.g. a tone color).
        if (dotColor != null) {
            Spacer(
                modifier = Modifier
                    .size(7.dp)
                    .clip(CircleShape)
                    .background(dotColor),
            )
        }

        // The label text itself, uppercased mono.
        Text(
            text = text.uppercase(),
            style = labelStyle,
            color = c.textDim,
        )

        // Required marker, coral asterisk.
        if (required) {
            Text(
                text = "*",
                style = labelStyle,
                color = c.coral,
            )
        }

        // Inline helper note, lighter and in normal case.
        if (optionalNote != null) {
            Text(
                text = optionalNote,
                style = AuntieTheme.typography.bodySmall.copy(fontSize = 11.sp),
                color = c.textFaint,
            )
        }

        // Push the action link to the trailing edge.
        if (actionText != null && onAction != null) {
            Spacer(modifier = Modifier.weight(1f))
            ActionLink(text = actionText, onClick = onAction, style = labelStyle)
        }
    }
}

/** Trailing mono action link. Dimmed at rest, primary on hover. */
@Composable
private fun ActionLink(
    text: String,
    onClick: () -> Unit,
    style: TextStyle,
) {
    val c = AuntieTheme.colors
    val interaction = remember { MutableInteractionSource() }
    val hovered = interaction.collectIsHoveredAsState().value
    val color = animateColorAsState(
        if (hovered) c.primary else c.textDim,
        label = "fieldLabelAction",
    ).value

    Text(
        text = text.uppercase(),
        style = style.copy(fontWeight = FontWeight.SemiBold),
        color = color,
        modifier = Modifier
            .clip(RoundedCornerShape(4.dp))
            .clickable(
                interactionSource = interaction,
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = 2.dp, vertical = 2.dp),
    )
}
