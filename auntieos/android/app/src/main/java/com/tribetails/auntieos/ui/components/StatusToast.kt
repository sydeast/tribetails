package com.tribetails.auntieos.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.ui.theme.*
import com.tribetails.auntieos.ui.theme.AuntieTheme
import kotlinx.coroutines.delay

enum class ToastKind { Info, Success, Error }

@Composable
fun StatusToast(
    visible: Boolean,
    message: String,
    kind: ToastKind = ToastKind.Info,
    onDismiss: () -> Unit = {},
    autoDismissMillis: Long = 4000L,
    modifier: Modifier = Modifier,
) {
    val (borderColor, tint) = when (kind) {
        ToastKind.Success -> AuntieTheme.colors.success to AuntieTheme.colors.success.copy(alpha = 0.12f).compositeOver(AuntieTheme.colors.surface)
        ToastKind.Error   -> AuntieTheme.colors.error to AuntieTheme.colors.error.copy(alpha = 0.12f).compositeOver(AuntieTheme.colors.surface)
        ToastKind.Info    -> AuntieTheme.colors.kinfolkOrange    to AuntieTheme.colors.kinfolkOrange.copy(alpha = 0.10f).compositeOver(AuntieTheme.colors.surface)
    }
    val textColor = when (kind) {
        ToastKind.Success -> AuntieTheme.colors.success
        ToastKind.Error   -> AuntieTheme.colors.error
        ToastKind.Info    -> AuntieTheme.colors.kinfolkOrange
    }

    if (visible && autoDismissMillis > 0) {
        LaunchedEffect(message) {
            delay(autoDismissMillis)
            onDismiss()
        }
    }

    AnimatedVisibility(
        visible = visible,
        enter = fadeIn() + slideInVertically { -it },
        exit = fadeOut() + slideOutVertically { -it },
        modifier = modifier.statusBarsPadding(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .background(tint)
                .border(1.dp, borderColor, RoundedCornerShape(8.dp))
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = message,
                color = textColor,
                style = AuntieTheme.typography.bodyMedium,
            )
        }
    }
}
