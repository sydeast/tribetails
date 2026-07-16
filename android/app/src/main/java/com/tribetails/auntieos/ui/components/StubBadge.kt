package com.tribetails.auntieos.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme

@Composable
fun StubBadge(
    title: String,
    body: String,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.08f).compositeOver(AuntieTheme.colors.surface))
            .border(1.dp, AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.45f), RoundedCornerShape(8.dp))
            .padding(14.dp),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(
            modifier = Modifier.size(8.dp).clip(CircleShape).background(AuntieTheme.colors.kinfolkOrange),
        )
        Column {
            Text(title, style = AuntieTheme.typography.titleMedium, color = AuntieTheme.colors.kinfolkOrange)
            Text(body, style = AuntieTheme.typography.bodySmall, color = AuntieTheme.colors.textDim)
        }
    }
}
