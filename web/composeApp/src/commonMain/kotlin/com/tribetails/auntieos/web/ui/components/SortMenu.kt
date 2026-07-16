package com.tribetails.auntieos.web.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.ArrowDownUp
import com.composables.icons.lucide.Check
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.web.theme.AuntieTheme
import com.tribetails.auntieos.web.util.SortOption

/**
 * Reusable "Sort: <option>" pill. Tap → dropdown of [SortOption] values.
 * Used by Directory, KinTales, Kin sub-directory.
 */
@Composable
fun SortMenu(
    selected: SortOption,
    onSelect: (SortOption) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    var expanded by remember { mutableStateOf(false) }
    Box(modifier = modifier) {
        Row(
            modifier = Modifier
                .clip(RoundedCornerShape(999.dp))
                .background(c.surface.copy(alpha = 0.6f).compositeOver(c.background))
                .border(AuntieTheme.dims.borderHairline, c.border, RoundedCornerShape(999.dp))
                .clickable { expanded = true }
                .padding(horizontal = 12.dp, vertical = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(
                imageVector = Lucide.ArrowDownUp,
                contentDescription = "Sort",
                tint = c.textDim,
                modifier = Modifier.size(14.dp),
            )
            Text(
                text = selected.label,
                style = AuntieTheme.typography.labelLarge,
                color = c.textPrimary,
            )
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
        ) {
            SortOption.entries.forEach { opt ->
                DropdownMenuItem(
                    text = { Text(opt.label, color = c.textPrimary) },
                    leadingIcon = if (opt == selected) {
                        {
                            Icon(
                                imageVector = Lucide.Check,
                                contentDescription = null,
                                tint = c.primary,
                                modifier = Modifier.size(14.dp),
                            )
                        }
                    } else {
                        { Box(modifier = Modifier.size(14.dp)) }
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
