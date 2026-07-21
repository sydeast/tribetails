package com.tribetails.auntieos.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.AuntieTheme

// ─────────────────────────────────────────────────────────────────────────────
// AuntieRadio - replaces M3 RadioButton
// Outer ring + animated inner dot, kinfolkOrange when selected.
// ─────────────────────────────────────────────────────────────────────────────

internal data class RadioVisualState(
    val innerScale: Float,
    val alpha: Float,
)

internal fun shouldFireRadioClick(enabled: Boolean, selected: Boolean): Boolean =
    enabled && !selected

internal fun computeRadioVisualState(selected: Boolean, enabled: Boolean): RadioVisualState =
    RadioVisualState(
        innerScale = if (selected) 1f else 0f,
        alpha      = if (enabled) 1f else 0.4f,
    )

@Composable
fun AuntieRadio(
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val state = computeRadioVisualState(selected, enabled)
    val ringColor by animateColorAsState(
        targetValue = if (selected) AuntieTheme.colors.kinfolkOrange else AuntieTheme.colors.border,
        label       = "radioRing",
    )
    val innerScale by animateFloatAsState(targetValue = state.innerScale, label = "radioInner")
    Box(
        modifier = modifier
            .alpha(state.alpha)
            .semantics { role = Role.RadioButton }
            .size(20.dp)
            .clip(CircleShape)
            .border(2.dp, ringColor, CircleShape)
            .clickable(enabled = enabled) {
                if (shouldFireRadioClick(enabled, selected)) onClick()
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            modifier = Modifier
                .scale(innerScale)
                .size(10.dp)
                .clip(CircleShape)
                .background(AuntieTheme.colors.kinfolkOrange),
        )
    }
}
