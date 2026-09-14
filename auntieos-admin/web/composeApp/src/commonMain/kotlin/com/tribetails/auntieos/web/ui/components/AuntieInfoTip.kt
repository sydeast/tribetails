package com.tribetails.auntieos.web.ui.components

import androidx.compose.foundation.layout.size
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Text
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.composables.icons.lucide.Info
import com.composables.icons.lucide.Lucide
import com.tribetails.auntieos.web.theme.AuntieTheme
import kotlinx.coroutines.launch

const val AUNTIE_INFO_TIP_TAG = "auntie-info-tip"

/**
 * A small "i" that holds one sentence of explanation, the desktop twin of admin
 * Android's `DenInfoTip` (operator ruling 2026-09-13: no explanatory subtitle
 * under panel titles, a tooltip at most). TooltipBox answers hover and
 * long-press; the tap is wired by hand so a click shows it too. The icon's
 * content description is the sentence itself, so a screen reader hears it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AuntieInfoTip(text: String, modifier: Modifier = Modifier) {
    val c = AuntieTheme.colors
    val state = rememberTooltipState()
    val scope = rememberCoroutineScope()
    TooltipBox(
        positionProvider = TooltipDefaults.rememberPlainTooltipPositionProvider(),
        tooltip = { PlainTooltip { Text(text, style = AuntieTheme.typography.bodySmall) } },
        state = state,
        modifier = modifier,
    ) {
        IconButton(
            onClick = { scope.launch { state.show() } },
            modifier = Modifier.size(24.dp).testTag(AUNTIE_INFO_TIP_TAG),
        ) {
            Icon(
                imageVector = Lucide.Info,
                contentDescription = text,
                tint = c.textDim,
                modifier = Modifier.size(16.dp),
            )
        }
    }
}
