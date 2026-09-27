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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
 *
 * [resetKey] restarts the auto-dismiss clock. It defaults to [message], which is
 * wrong for a host that can show the SAME message twice in a row (#854: e.g. two
 * "Saved." toasts from two different screens back to back) - [RouteToastHost]
 * passes a token that changes on every call to `show(...)`, message included.
 */
@Composable
fun StatusToast(
    visible: Boolean,
    message: String,
    kind: ToastKind = ToastKind.Info,
    onDismiss: () -> Unit = {},
    autoDismissMillis: Long = 4000L,
    modifier: Modifier = Modifier,
    resetKey: Any? = message,
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
        LaunchedEffect(resetKey) {
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

/**
 * #854: a save confirmation set on the screen the operator is leaving never
 * shows, because that screen (and its local toast state) is disposed by the
 * navigation the save triggers in the same code path. [RouteToastHost] holds
 * the toast one level above every `when(route)` / `when(current)` dispatch in
 * the desktop app (wired once, in `App.kt`, around the whole signed-in
 * content), so it survives every navigation underneath it - top-level tab
 * switches and every screen's own nested router. A screen that shows a toast
 * and then navigates away calls `LocalRouteToast.current.show(...)` instead
 * of its own local toast state for THAT message; every other toast on that
 * screen (errors, in-place confirmations) is untouched and keeps rendering
 * locally, since the screen stays open for those.
 */
class RouteToastState internal constructor() {
    var message by mutableStateOf("")
        private set
    var kind by mutableStateOf(ToastKind.Info)
        private set
    var visible by mutableStateOf(false)
        private set

    /** Bumped on every [show], so two identical messages in a row each get their
     *  own [autoDismissMillis] window (see [StatusToast]'s `resetKey`). */
    var token by mutableStateOf(0)
        private set

    fun show(message: String, kind: ToastKind = ToastKind.Info) {
        this.message = message
        this.kind = kind
        this.visible = true
        this.token += 1
    }

    fun dismiss() {
        visible = false
    }
}

private val NoRouteToastHost = RouteToastState()

val LocalRouteToast = compositionLocalOf { NoRouteToastHost }

/**
 * Wraps [content] (a router's `when(route)` dispatch, or the whole app's) with
 * a [RouteToastHost] provided via [LocalRouteToast] and rendered as an overlay
 * above whatever [content] draws, so it is visible no matter which destination
 * is on screen when it fires.
 */
@Composable
fun RouteToastHost(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val host = remember { RouteToastState() }
    CompositionLocalProvider(LocalRouteToast provides host) {
        Box(modifier.fillMaxSize()) {
            content()
            Box(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .widthIn(max = AuntieTheme.dims.maxContentWidth)
                    .fillMaxWidth(),
            ) {
                StatusToast(
                    visible   = host.visible,
                    message   = host.message,
                    kind      = host.kind,
                    onDismiss = { host.dismiss() },
                    resetKey  = host.token,
                )
            }
        }
    }
}
