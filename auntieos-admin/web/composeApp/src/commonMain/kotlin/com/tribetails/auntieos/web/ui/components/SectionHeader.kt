package com.tribetails.auntieos.web.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.ArrowLeft
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.web.theme.AuntieTheme

@Composable
fun SectionHeader(
    title: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    subtitle: String? = null,
    onBack: (() -> Unit)? = null,
    breadcrumbs: List<String> = emptyList(),
    trailing: (@Composable () -> Unit)? = null,
) {
    val c = AuntieTheme.colors
    Column(modifier = modifier.fillMaxWidth().padding(bottom = 12.dp)) {
        if (breadcrumbs.isNotEmpty()) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                breadcrumbs.forEachIndexed { idx, crumb ->
                    Text(
                        text = crumb,
                        style = AuntieTheme.typography.labelSmall,
                        color = c.textFaint,
                    )
                    if (idx < breadcrumbs.lastIndex) {
                        Text(
                            text = "›",
                            style = AuntieTheme.typography.labelSmall,
                            color = c.textFaint,
                        )
                    }
                }
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if (onBack != null) {
                    Box(
                        modifier = Modifier
                            .size(28.dp)
                            .clip(CircleShape)
                            .clickable(onClick = onBack),
                        contentAlignment = Alignment.Center,
                    ) {
                        androidx.compose.material3.Icon(
                            imageVector = Lucide.ArrowLeft,
                            contentDescription = "Back",
                            tint = c.textDim,
                            modifier = Modifier.size(18.dp),
                        )
                    }
                }
                icon?.let {
                    androidx.compose.material3.Icon(
                        imageVector = it,
                        contentDescription = null,
                        tint = c.primary,
                        modifier = Modifier.size(18.dp),
                    )
                }
                Column {
                    Text(title, style = AuntieTheme.typography.headlineMedium, color = c.textPrimary)
                    if (subtitle != null) {
                        Text(subtitle, style = AuntieTheme.typography.bodySmall, color = c.textDim)
                    }
                }
            }
            trailing?.invoke()
        }
    }
}
