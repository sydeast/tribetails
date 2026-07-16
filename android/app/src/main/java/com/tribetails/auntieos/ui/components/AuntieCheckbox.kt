package com.tribetails.auntieos.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
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
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.ui.theme.AuntieTheme

// ─────────────────────────────────────────────────────────────────────────────
// AuntieCheckbox - replaces M3 Checkbox
// Rounded square, kinfolkOrange fill when checked, Lucide check icon.
// ─────────────────────────────────────────────────────────────────────────────

internal data class CheckboxVisualState(
    val fillAlpha: Float,
    val showCheck: Boolean,
    val overallAlpha: Float,
)

internal fun resolveCheckboxClick(enabled: Boolean, currentChecked: Boolean): Boolean? =
    if (enabled) !currentChecked else null

internal fun computeCheckboxVisualState(checked: Boolean, enabled: Boolean): CheckboxVisualState =
    CheckboxVisualState(
        fillAlpha    = if (checked) 1f else 0f,
        showCheck    = checked,
        overallAlpha = if (enabled) 1f else 0.4f,
    )

@Composable
fun AuntieCheckbox(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val state = computeCheckboxVisualState(checked, enabled)
    val borderColor by animateColorAsState(
        targetValue = if (checked) AuntieTheme.colors.kinfolkOrange else AuntieTheme.colors.border,
        label       = "checkboxBorder",
    )
    val fillAlpha by animateFloatAsState(targetValue = state.fillAlpha, label = "checkboxFill")
    val iconScale by animateFloatAsState(targetValue = if (state.showCheck) 1f else 0f, label = "checkboxIcon")
    val shape = RoundedCornerShape(6.dp)

    Box(
        modifier = modifier
            .alpha(state.overallAlpha)
            .semantics { role = Role.Checkbox }
            .size(20.dp)
            .clip(shape)
            .background(AuntieTheme.colors.kinfolkOrange.copy(alpha = fillAlpha))
            .border(2.dp, borderColor, shape)
            .clickable(enabled = enabled) {
                resolveCheckboxClick(enabled, checked)?.let(onCheckedChange)
            },
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector        = Lucide.Check,
            contentDescription = null,
            tint               = AuntieTheme.colors.background,
            modifier           = Modifier.size(14.dp).scale(iconScale),
        )
    }
}
