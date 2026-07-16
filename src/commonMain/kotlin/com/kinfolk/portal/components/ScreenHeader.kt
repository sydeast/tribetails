package com.kinfolk.portal.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.MailOutline
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkGradients
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography

/**
 * Standard top-of-screen hero header (the mockup's `.hero-greet`): an optional
 * mono kicker (meta-label) above the serif page [title], with an optional
 * [subtitle] beneath. The MyTribe wordmark, the notification bell, and the
 * avatar menu live in the persistent shell chrome (TabShell) — NOT here — so the
 * page header carries the page's own identity, not the family name.
 *
 * The "Message Auntie" chip renders ONLY when [onMessageAuntieClick] is supplied
 * (fail-loud: a screen that hasn't wired it never shows a dead, no-op control).
 */
@Composable
fun ScreenHeader(
    title: String,
    kicker: String? = null,
    subtitle: String? = null,
    onMessageAuntieClick: (() -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val type = LocalKinfolkTypography.current
    Box(
        modifier = modifier
            .fillMaxWidth()
            .background(KinfolkGradients.headerWash),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = KinfolkSpacing.l, end = KinfolkSpacing.m, top = KinfolkSpacing.l, bottom = KinfolkSpacing.m),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.Top,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                if (kicker != null) {
                    Text(
                        text = kicker.uppercase(),
                        style = type.sansMeta.copy(color = KinfolkBrand.KinfolkOrange),
                    )
                    Spacer(Modifier.height(KinfolkSpacing.xs))
                }
                Text(
                    text = title,
                    style = type.heritageDisplay,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                if (subtitle != null) {
                    Spacer(Modifier.height(KinfolkSpacing.xs))
                    Text(
                        text = subtitle,
                        style = type.sansBody.copy(color = KinfolkBrand.NavyMuted),
                    )
                }
            }
            if (onMessageAuntieClick != null) {
                AssistChip(
                    onClick = onMessageAuntieClick,
                    label = { Text("Message Auntie") },
                    leadingIcon = {
                        Icon(
                            imageVector = Icons.Outlined.MailOutline,
                            contentDescription = null,
                            tint = KinfolkBrand.PackPink,
                        )
                    },
                    colors = AssistChipDefaults.assistChipColors(
                        containerColor = KinfolkBrand.GlassSurface,
                        labelColor = KinfolkBrand.PackPink,
                    ),
                )
            }
        }
    }
}
