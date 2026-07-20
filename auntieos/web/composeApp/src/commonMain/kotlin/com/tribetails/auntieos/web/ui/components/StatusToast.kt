package com.tribetails.auntieos.web.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.unit.dp
import com.tribetails.auntieos.web.theme.AuntieTheme
import kotlinx.coroutines.delay

enum class ToastKind { Info, Success, Error }

/**
 * Inline status toast slot. Pair with any async action so the user always sees
 * confirmation of what happened. Auto-dismisses after [autoDismissMillis] when > 0.
 */
@Composable
fun StatusToast(
    visible: Boolean,
    message: String,
    kind: ToastKind = ToastKind.Info,
    onDismiss: () -> Unit = {},
    autoDismissMillis: Long = 4000L,
    modifier: Modifier = Modifier,
) {
    val c = AuntieTheme.colors
    val (border, tint) = when (kind) {
        ToastKind.Success -> c.success to c.success.copy(alpha = 0.12f).compositeOver(c.surface)
        ToastKind.Error   -> c.error   to c.error.copy(alpha = 0.12f).compositeOver(c.surface)
        ToastKind.Info    -> c.primary    to c.primary.copy(alpha = 0.10f).compositeOver(c.surface)
    }
    val textColor: Color = when (kind) {
        ToastKind.Success -> c.success
        ToastKind.Error   -> c.error
        ToastKind.Info    -> c.primary
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
        exit  = fadeOut() + slideOutVertically { -it },
        modifier = modifier,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(8.dp))
                .background(tint)
                .border(AuntieTheme.dims.borderHairline, border, RoundedCornerShape(8.dp))
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text  = message,
                color = textColor,
                style = AuntieTheme.typography.bodyMedium,
            )
        }
    }
}
