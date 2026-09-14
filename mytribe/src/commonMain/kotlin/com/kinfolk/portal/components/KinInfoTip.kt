package com.kinfolk.portal.components

import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.PlainTooltip
import androidx.compose.material3.Text
import androidx.compose.material3.TooltipAnchorPosition
import androidx.compose.material3.TooltipBox
import androidx.compose.material3.TooltipDefaults
import androidx.compose.material3.rememberTooltipState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.theme.KinfolkBrand
import com.kinfolk.portal.theme.KinfolkTheme
import kotlinx.coroutines.launch

const val KIN_INFO_TIP_TAG = "kin-info-tip"

/**
 * A small "i" that holds one sentence of explanation, mirroring admin Android's
 * `DenInfoTip` (operator ruling 2026-09-13) and portal web's `InfoTip`. It stands
 * in for a subtitle under a card title, which the 2026-09-11 ruling removed.
 *
 * TooltipBox answers long-press; the tap is wired by hand, because without it the
 * tip is a gesture nobody finds. The tooltip is persistent, so it stays open for
 * reading until a tap elsewhere closes it, as the web tip does. The icon's
 * content description is the sentence itself, so TalkBack reads it.
 * `ExperimentalMaterial3Api` is opted in module-wide.
 */
@Composable
fun KinInfoTip(text: String, modifier: Modifier = Modifier) {
    val state = rememberTooltipState(isPersistent = true)
    val scope = rememberCoroutineScope()
    TooltipBox(
        positionProvider = TooltipDefaults.rememberTooltipPositionProvider(TooltipAnchorPosition.Above),
        tooltip = { PlainTooltip { Text(text, style = KinfolkTheme.typography.sansMeta) } },
        state = state,
        modifier = modifier,
    ) {
        IconButton(
            onClick = { scope.launch { state.show() } },
            modifier = Modifier.size(24.dp).testTag(KIN_INFO_TIP_TAG),
        ) {
            Icon(
                imageVector = Icons.Outlined.Info,
                contentDescription = text,
                tint = KinfolkBrand.NavyMuted,
                modifier = Modifier.size(16.dp),
            )
        }
    }
}
