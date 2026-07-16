package com.tribetails.auntieos.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.AuntieTheme

// ─────────────────────────────────────────────────────────────────────────────
// AuntieToggle - replaces M3 Switch
// Flat track + animated thumb, kinfolkOrange when on, no M3 ripple.
// ─────────────────────────────────────────────────────────────────────────────

internal data class ToggleVisualState(
    val thumbProgress: Float,
    val trackAlpha: Float,
    val callbackEnabled: Boolean,
)

internal fun resolveToggleClick(enabled: Boolean, currentChecked: Boolean): Boolean? =
    if (enabled) !currentChecked else null

internal fun computeToggleVisualState(checked: Boolean, enabled: Boolean): ToggleVisualState =
    ToggleVisualState(
        thumbProgress   = if (checked) 1f else 0f,
        trackAlpha      = if (enabled) 1f else 0.4f,
        callbackEnabled = enabled,
    )

@Composable
fun AuntieToggle(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val state = computeToggleVisualState(checked, enabled)
    val trackColor by animateColorAsState(
        targetValue = if (checked) AuntieTheme.colors.kinfolkOrange else AuntieTheme.colors.surface2,
        label       = "toggleTrack",
    )
    val thumbOffset by animateDpAsState(
        targetValue   = if (checked) 22.dp else 2.dp,
        animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
        label         = "toggleThumb",
    )
    Box(
        modifier = modifier
            .alpha(state.trackAlpha)
            .semantics { role = Role.Switch }
            .width(46.dp)
            .height(26.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(trackColor)
            .clickable(enabled = state.callbackEnabled) {
                resolveToggleClick(state.callbackEnabled, checked)?.let(onCheckedChange)
            },
        contentAlignment = Alignment.CenterStart,
    ) {
        Box(
            modifier = Modifier
                .offset(x = thumbOffset)
                .size(22.dp)
                .clip(CircleShape)
                .background(Color.White),
        )
    }
}
