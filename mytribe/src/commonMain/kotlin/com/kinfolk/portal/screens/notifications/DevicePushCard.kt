package com.kinfolk.portal.screens.notifications
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinGhostButton
import com.kinfolk.portal.push.DevicePushCardKind
import com.kinfolk.portal.push.DevicePushState
import com.kinfolk.portal.push.PushRegistrationCoordinator
import com.kinfolk.portal.push.devicePushCardKind
import com.kinfolk.portal.theme.KinfolkSpacing
import com.kinfolk.portal.theme.LocalKinfolkTypography
import kotlinx.coroutines.launch
/** Card copy, shared with the web portal's PushPrompt where the words apply. */
internal const val PUSH_ENABLE_TITLE = "Get notified about visits"
internal const val PUSH_ENABLE_BODY = "Know the moment your Auntie checks in, sends a KinTale, or replies to a message."
internal const val PUSH_ENABLE_BUTTON = "Enable notifications"
internal const val PUSH_BLOCKED_TITLE = "Notifications are blocked"
internal const val PUSH_BLOCKED_BODY =
    "To get them, open your phone's notification settings for MyTribe and turn on Allow notifications. Then come back here."
internal const val PUSH_TURNED_OFF_BODY =
    "Notifications are turned off for MyTribe in your phone's settings. Turn them back on to hear about visits."
internal const val PUSH_SETTINGS_BUTTON = "Open notification settings"
internal const val PUSH_FINISH_TITLE = "Finish turning on notifications"
/**
 * The one notifications card for this device (#1787, #1788), on Home and on
 * Notification Settings. Which card shows comes from [devicePushCardKind]:
 * Enable (the system dialog opens only from its button), Blocked or turned off
 * in system settings (button opens the app's notification settings), or Finish
 * with the coded error and a Retry when registration failed. [onDismiss] is
 * Home's session-long "Maybe later"; Notification Settings passes null and
 * always shows the card.
 */
@Composable
internal fun DevicePushCard(coordinator: PushRegistrationCoordinator, onDismiss: (() -> Unit)?) {
    val gate = coordinator.permissionGate
    val permission by gate.state.collectAsState()
    val push by coordinator.state.collectAsState()
    // Re-read when the screen appears, so a change made in system settings shows at once.
    DisposableEffect(gate) {
        gate.refresh()
        onDispose { }
    }
    val kind = devicePushCardKind(permission, push)
    if (kind == DevicePushCardKind.None) return
    val type = LocalKinfolkTypography.current
    val scope = rememberCoroutineScope()
    var retrying by remember { mutableStateOf(false) }
    GlassCard(
        modifier = Modifier.fillMaxWidth().padding(horizontal = KinfolkSpacing.l).testTag("device-push-card"),
        contentPadding = PaddingValues(KinfolkSpacing.l),
    ) {
        Column(verticalArrangement = Arrangement.spacedBy(KinfolkSpacing.s)) {
            when (kind) {
                DevicePushCardKind.Enable -> {
                    Text(PUSH_ENABLE_TITLE, style = type.heritageTitle, modifier = Modifier.testTag("device-push-title"))
                    Text(PUSH_ENABLE_BODY, style = type.sansBody)
                    KinButton(
                        label = PUSH_ENABLE_BUTTON,
                        onClick = { gate.requestPermission() },
                        modifier = Modifier.testTag("device-push-enable"),
                    )
                }
                DevicePushCardKind.Blocked, DevicePushCardKind.TurnedOff -> {
                    Text(PUSH_BLOCKED_TITLE, style = type.heritageTitle, modifier = Modifier.testTag("device-push-title"))
                    Text(
                        if (kind == DevicePushCardKind.Blocked) PUSH_BLOCKED_BODY else PUSH_TURNED_OFF_BODY,
                        style = type.sansBody,
                        modifier = Modifier.testTag("device-push-blocked-body"),
                    )
                    KinButton(
                        label = PUSH_SETTINGS_BUTTON,
                        onClick = { gate.openSystemSettings() },
                        modifier = Modifier.testTag("device-push-open-settings"),
                    )
                }
                else -> {
                    val failed = push as? DevicePushState.Failed
                    Text(PUSH_FINISH_TITLE, style = type.heritageTitle, modifier = Modifier.testTag("device-push-title"))
                    if (failed != null) {
                        Text(devicePushFailureLine(failed), style = type.sansBody, modifier = Modifier.testTag("device-push-error"))
                    }
                    KinButton(
                        label = if (retrying) "Retrying…" else "Retry",
                        enabled = !retrying,
                        onClick = {
                            retrying = true
                            scope.launch {
                                try {
                                    coordinator.retry()
                                } finally {
                                    retrying = false
                                }
                            }
                        },
                        modifier = Modifier.testTag("device-push-retry"),
                    )
                }
            }
            if (onDismiss != null) {
                KinGhostButton(
                    label = if (kind == DevicePushCardKind.Enable) "Maybe later" else "Close",
                    onClick = onDismiss,
                    modifier = Modifier.testTag("device-push-dismiss"),
                )
            }
        }
    }
}
/** The error line under the title: the stage and the exception, never a token. */
internal fun devicePushFailureLine(failed: DevicePushState.Failed): String =
    "Could not enable notifications: ${failed.detail} (${failed.stage})"
