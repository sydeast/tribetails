package com.kinfolk.portal.components

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Phone
import androidx.compose.material.icons.filled.Sms
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkShapes
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography

/**
 * Outline pill action. Lived as a private helper in TribeScreen.kt; lifted here
 * so the About screen (#1411) draws the same Call / Text pair Tribe Profile does.
 */
@Composable
fun GhostPillButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    icon: ImageVector? = null,
    color: Color = KinfolkBrand.Navy,
) {
    val type = LocalKinfolkTypography.current
    val contentColor = if (enabled) color else KinfolkBrand.NavyMuted
    Row(
        modifier = modifier
            .clip(KinfolkShapes.pill)
            .border(1.dp, contentColor.copy(alpha = 0.45f), KinfolkShapes.pill)
            .clickable(enabled = enabled) { onClick() }
            .padding(horizontal = KinfolkSpacing.m, vertical = 11.dp),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = null, tint = contentColor, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(KinfolkSpacing.xs))
        }
        Text(label, style = type.sansLabel.copy(color = contentColor))
    }
}

/**
 * The Call and Text pair for a phone number, two equal-width pills on `tel:` and
 * `sms:`. Tribe Profile's auntie contact card and the About screen (#1411) share
 * it. [openUrl] is the caller's seam (see UrlOpenerSeamGuardTest); a blank
 * number draws nothing.
 */
@Composable
fun RowScope.PhoneActionPills(phone: String, openUrl: (String) -> Unit) {
    val number = phone.trim()
    if (number.isEmpty()) return
    GhostPillButton(
        label = "Call",
        onClick = { openUrl("tel:$number") },
        icon = Icons.Filled.Phone,
        modifier = Modifier.weight(1f),
    )
    GhostPillButton(
        label = "Text",
        onClick = { openUrl("sms:$number") },
        icon = Icons.Filled.Sms,
        modifier = Modifier.weight(1f),
    )
}
