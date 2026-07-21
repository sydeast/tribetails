package com.tribetails.auntieos.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.ArrowDown
import com.composables.icons.lucide.ArrowUp
import com.composables.icons.lucide.EyeOff
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.ui.components.AuntieField
import com.tribetails.auntieos.ui.components.AuntieSaveBar
import com.tribetails.auntieos.ui.components.DenPanel
import com.tribetails.auntieos.ui.components.GhostButton
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * 17.4 Nav editor (android). Reorder / rename / show-hide the bottom-nav tabs,
 * persisted per-admin to UserProfile.navConfig (keys = bottom-nav routes). Edits stage
 * locally and commit via the Save bar in one write. Leaving it untouched keeps
 * navConfig empty, so the bar renders its shipped default tabs.
 */
@Composable
fun NavigationSettingsPanel(
    navConfig: List<String>,
    canSave: Boolean,
    onSave: (List<String>) -> Unit,
) {
    val c = AuntieTheme.colors
    val dims = AuntieTheme.dims
    val defaultKeys = remember { bottomNavScreens.map { it.route } }
    fun fallbackLabel(key: String): String = bottomNavScreens.firstOrNull { it.route == key }?.label ?: key

    val baseline = resolvedNav(navConfig, defaultKeys)
    var entries by remember(navConfig) { mutableStateOf(baseline) }
    var saving by remember { mutableStateOf(false) }
    val dirty = entries != baseline

    DenPanel(
        title = "Navigation",
        subtitle = "Reorder, rename, or hide the tabs in your bottom menu. Leave it untouched to keep the standard tabs.",
    ) {
        Column {
            entries.forEachIndexed { i, e ->
                val fallback = fallbackLabel(e.key)
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    AuntieField(
                        value = e.label(fallback),
                        onValueChange = { entries = renameNav(entries, e.key, it) },
                        label = fallback,
                        modifier = Modifier.weight(1f),
                    )
                    NavCtl(Lucide.ArrowUp, "Move $fallback up", i > 0) { entries = moveNavUp(entries, i) }
                    NavCtl(Lucide.ArrowDown, "Move $fallback down", i < entries.lastIndex) { entries = moveNavDown(entries, i) }
                    NavCtl(Lucide.EyeOff, "Hide $fallback", true) { entries = hideNav(entries, e.key) }
                }
            }

            val hidden = hiddenNavKeys(entries, defaultKeys)
            if (hidden.isNotEmpty()) {
                Spacer(Modifier.height(12.dp))
                Text("Hidden tabs", style = AuntieTheme.typography.labelSmall, color = c.textFaint)
                Spacer(Modifier.height(6.dp))
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    hidden.forEach { k ->
                        GhostButton(
                            label = fallbackLabel(k),
                            onClick = { entries = showNav(entries, k) },
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }

            Spacer(Modifier.height(14.dp))
            AuntieSaveBar(
                dirty = dirty,
                saveEnabled = dirty && !saving && canSave,
                onCancel = { entries = baseline },
                onSave = { saving = true; onSave(entries.toNavTokens()); saving = false },
                dirtyLabel = "Unsaved navigation",
                savedLabel = "Navigation saved",
            )
        }
    }
}

@Composable
private fun NavCtl(icon: ImageVector, desc: String, enabled: Boolean, onClick: () -> Unit) {
    val c = AuntieTheme.colors
    Box(
        modifier = Modifier
            .size(32.dp)
            .clip(RoundedCornerShape(8.dp))
            .then(if (enabled) Modifier.clickable(onClick = onClick) else Modifier)
            .alpha(if (enabled) 1f else 0.35f),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = desc, tint = c.textDim, modifier = Modifier.size(18.dp))
    }
}
