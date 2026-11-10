package com.kinfolk.portal.screens.notifications
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.kinfolk.portal.components.GlassCard
import com.kinfolk.portal.components.KinButton
import com.kinfolk.portal.components.KinGhostButton
import com.kinfolk.portal.components.KinSpinner
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
/** #1808: Notification Settings only, same words as the web portal. */
internal const val PUSH_ON_LINE = "Notifications are on for this device."
internal const val PUSH_SIGNING_UP_LINE = "Signing up this device…"
/**
 * The one notifications card for this device (#1787, #1788), on Home and on
 * Notification Settings. Which card shows comes from [devicePushCardKind]:
 * Enable (the system dialog opens only from its button), Blocked or turned off
 * in system settings (button opens the app's notification settings), or Finish
 * with the coded error and a Retry when registration failed. [onDismiss] is
 * Home's session-long "Maybe later"; Notification Settings passes null and
 * always shows the card.
 *
 * #1808: Notification Settings also passes [showDeviceStatus], so a device that
 * is signed up says "Notifications are on for this device." and one whose
 * sign-up is still running says "Signing up this device…" with a spinner. Home
 * leaves it false and shows no card for either.
 */
@Composable
internal fun DevicePushCard(
    coordinator: PushRegistrationCoordinator,
    onDismiss: (() -> Unit)?,
    showDeviceStatus: Boolean = false,
) {
    val gate = coordinator.permissionGate
    val permission by gate.state.collectAsState()
    val push by coordinator.state.collectAsState()
    // Re-read when the screen appears, so a change made in system settings shows at once.
    DisposableEffect(gate) {
        gate.refresh()
        onDispose { }
    }
    val kind = devicePushCardKind(permission, push, showDeviceStatus)
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
                DevicePushCardKind.Finish -> {
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
                DevicePushCardKind.On -> {
                    Text(PUSH_ON_LINE, style = type.sansBody, modifier = Modifier.testTag("device-push-on"))
                }
                DevicePushCardKind.SigningUp -> {
                    Row(
                        horizontalArrangement = Arrangement.spacedBy(KinfolkSpacing.s),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        KinSpinner(size = 20.dp, modifier = Modifier.testTag("device-push-spinner"))
                        Text(PUSH_SIGNING_UP_LINE, style = type.sansBody, modifier = Modifier.testTag("device-push-signing-up"))
                    }
                }
                DevicePushCardKind.None -> Unit
            }
            // The status lines are not offers, so there is nothing to put off.
            val dismissable = kind != DevicePushCardKind.On && kind != DevicePushCardKind.SigningUp
            if (onDismiss != null && dismissable) {
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
