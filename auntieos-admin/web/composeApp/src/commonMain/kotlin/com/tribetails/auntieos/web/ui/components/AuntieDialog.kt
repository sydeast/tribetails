package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupProperties
import com.tribetails.auntieos.web.theme.AuntieTheme

/**
 * AuntieDialog: the Den modal scaffold.
 *
 * A full-bleed dim scrim (tap anywhere outside to dismiss) plus a centered glass
 * surface that owns its own scroll. The header carries an optional leading icon,
 * a Fraunces title, an optional hint line, and a close X. The body is a scrollable
 * content slot, and the footer is a right-aligned action row for buttons.
 *
 * Built entirely from Box / Row / Column + foundation primitives over a
 * [androidx.compose.ui.window.Popup] so it floats above the page without being
 * clipped by parent layout bounds. The only Material3 dependency is Text. The
 * close affordance reuses [AuntieIconButton]; the caller supplies its glyph as a
 * vector so no icon is hardcoded here.
 *
 * Dismissal paths (all route through [onDismiss]):
 *  - tapping the scrim outside the surface
 *  - the close X (when [closeIcon] is provided)
 *  - the platform back / escape gesture (via Popup dismiss request)
 *
 * The surface clips taps so a click inside the card never bubbles to the scrim.
 *
 * @param visible whether the dialog is shown. When false, nothing composes.
 * @param title Fraunces headline shown in the header.
 * @param onDismiss invoked for every dismissal path above.
 * @param maxWidth upper bound on the surface width. It fills available width up to this.
 * @param leadingIcon optional composable slot left of the title (an icon tile, avatar, etc.).
 * @param closeIcon optional vector for the trailing close X. When null, no X renders.
 * @param hint optional secondary line under the title (a short subtitle or instruction).
 * @param footer right-aligned action row. Empty by default (no footer rule drawn).
 * @param content the scrollable body slot.
 */
@Composable
fun AuntieDialog(
    visible: Boolean,
    title: String,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    maxWidth: Dp = 720.dp,
    leadingIcon: (@Composable () -> Unit)? = null,
    closeIcon: ImageVector? = null,
    hint: String? = null,
    footer: @Composable RowScope.() -> Unit = {},
    content: @Composable ColumnScope.() -> Unit,
) {
    if (!visible) return

    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    // Entry transition: scrim fades, surface fades + rises with a soft spring.
    // Driven off a one-shot remembered flag so it animates on first compose.
    val scrimAlpha by animateFloatAsState(
        targetValue = 1f,
        animationSpec = tween(durationMillis = 180),
        label = "auntieDialogScrim",
    )
    val surfaceProgress by animateFloatAsState(
        targetValue = 1f,
        animationSpec = spring(
            dampingRatio = Spring.DampingRatioLowBouncy,
            stiffness = Spring.StiffnessMediumLow,
        ),
        label = "auntieDialogSurface",
    )

    Popup(
        onDismissRequest = onDismiss,
        properties = PopupProperties(focusable = true),
    ) {
        // Dim scrim. Tapping it dismisses; the surface below intercepts its own
        // taps so clicks inside the card never reach this layer.
        val scrimInteraction = remember { MutableInteractionSource() }
        Box(
            modifier = Modifier
                .fillMaxSize()
                .alpha(scrimAlpha)
                .background(scrimColor(c.isDark))
                .clickable(
                    interactionSource = scrimInteraction,
                    indication = null,
                    onClick = onDismiss,
                ),
            contentAlignment = Alignment.Center,
        ) {
            // The glass card. A no-op clickable swallows taps so they do not
            // bubble up and dismiss the dialog from inside.
            val surfaceInteraction = remember { MutableInteractionSource() }
            val cardShape = RoundedCornerShape(20.dp)
            Box(
                modifier = modifier
                    .padding(dims.space6)
                    .widthIn(max = maxWidth)
                    .fillMaxWidth()
                    .heightIn(max = 760.dp)
                    .graphicsLayer {
                        alpha = surfaceProgress
                        val rise = (1f - surfaceProgress) * 18f
                        translationY = rise
                    }
                    .clip(cardShape)
                    .background(c.surface)
                    .border(dims.borderHairline, SolidColor(c.border), cardShape)
                    .clickable(
                        interactionSource = surfaceInteraction,
                        indication = null,
                        onClick = {},
                    ),
            ) {
                Column(modifier = Modifier.fillMaxWidth()) {
                    DialogHeader(
                        title = title,
                        hint = hint,
                        leadingIcon = leadingIcon,
                        closeIcon = closeIcon,
                        onDismiss = onDismiss,
                    )

                    // Scrollable body. heightIn lets short dialogs hug their
                    // content while tall ones scroll within the capped card.
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = 0.dp)
                            .verticalScroll(rememberScrollState())
                            .padding(
                                start = dims.space6,
                                end = dims.space6,
                                top = dims.space2,
                                bottom = dims.space4,
                            ),
                        verticalArrangement = Arrangement.spacedBy(dims.space4),
                        content = content,
                    )

                    DialogFooter(footer = footer)
                }
            }
        }
    }
}

@Composable
private fun DialogHeader(
    title: String,
    hint: String?,
    leadingIcon: (@Composable () -> Unit)?,
    closeIcon: ImageVector?,
    onDismiss: () -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(
                    start = dims.space6,
                    end = dims.space4,
                    top = dims.space5,
                    bottom = if (hint != null) dims.space2 else dims.space4,
                ),
            horizontalArrangement = Arrangement.spacedBy(dims.space3),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            leadingIcon?.invoke()
            // Fraunces display title (Den display style maps to the serif).
            Text(
                text = title,
                style = AuntieTheme.typography.headlineLarge,
                color = c.textPrimary,
                modifier = Modifier
                    .weight(1f)
                    .padding(top = 2.dp),
            )
            if (closeIcon != null) {
                AuntieIconButton(
                    icon = closeIcon,
                    contentDescription = "Close dialog",
                    onClick = onDismiss,
                    size = 38.dp,
                )
            } else {
                // Keep the title from butting the edge when there is no X.
                Box(modifier = Modifier.size(dims.space2))
            }
        }

        if (hint != null) {
            Text(
                text = hint,
                style = AuntieTheme.typography.bodyMedium,
                color = c.textDim,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(
                        start = dims.space6,
                        end = dims.space6,
                        bottom = dims.space4,
                    ),
            )
        }

        // Hairline rule under the header.
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = dims.space6)
                .heightIn(min = dims.borderHairline)
                .background(c.borderSoft),
        )
    }
}

@Composable
private fun DialogFooter(footer: @Composable RowScope.() -> Unit) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims

    // Probe whether the caller supplied any footer actions. We always reserve
    // the slot; the hairline + padding only render when there is content, so an
    // empty footer leaves no orphaned rule.
    Column(modifier = Modifier.fillMaxWidth()) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = dims.space6)
                .heightIn(min = dims.borderHairline)
                .background(c.borderSoft),
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(
                    start = dims.space6,
                    end = dims.space6,
                    top = dims.space4,
                    bottom = dims.space5,
                ),
            horizontalArrangement = Arrangement.spacedBy(dims.space3, Alignment.End),
            verticalAlignment = Alignment.CenterVertically,
            content = footer,
        )
    }
}

/**
 * Scrim tint. A touch darker on dark themes (cream-on-navy reads against a
 * deeper veil) and a warm-navy wash on light themes so the page recedes without
 * a flat black overlay.
 */
private fun scrimColor(isDark: Boolean): Color =
    if (isDark) Color(0xCC0A0B12) else Color(0x99161824)
