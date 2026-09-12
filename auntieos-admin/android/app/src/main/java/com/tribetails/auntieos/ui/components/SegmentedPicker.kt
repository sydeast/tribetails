package com.tribetails.auntieos.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme

/**
 * The mocks' `.tabs`: a segmented control on a surface track, the selected
 * segment filled with the page's text colour and lettered in the page's
 * ground (`.tabs button.on{background:var(--cream);color:var(--navy)}`), so
 * cream on navy in the dark scheme and navy on cream in the light. It used to
 * select in Kinfolk Orange, which no mock draws for a segment (#780); orange
 * is the primary button's, and a filter that lit up like a CTA read as one.
 * `textPrimary` and `background` are the two role tokens that swap together
 * across the schemes, which is why the pair is read off the theme rather than
 * the brand constants.
 */
@Composable
fun <T> SegmentedPicker(
    options: List<T>,
    selected: T,
    onSelect: (T) -> Unit,
    label: (T) -> String,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .height(34.dp)
            .clip(RoundedCornerShape(999.dp))
            .background(AuntieTheme.colors.surface2)
            .border(1.dp, AuntieTheme.colors.border, RoundedCornerShape(999.dp))
            .padding(2.dp),
    ) {
        options.forEach { opt ->
            val isOn = opt == selected
            val bg = animateColorAsState(if (isOn) AuntieTheme.colors.textPrimary else AuntieTheme.colors.surface2, label = "segBg").value
            val fg = animateColorAsState(if (isOn) AuntieTheme.colors.background else AuntieTheme.colors.textDim, label = "segFg").value
            Box(
                modifier = Modifier
                    // fillMaxHeight so the active pill spans the full inner track height
                    // (was floating shorter than the rail = the "pill-in-pill" complaint).
                    .fillMaxHeight()
                    .clip(RoundedCornerShape(999.dp))
                    .background(bg)
                    .clickable { onSelect(opt) }
                    .padding(horizontal = 14.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(label(opt), style = AuntieTheme.typography.labelLarge, color = fg)
            }
        }
    }
}
