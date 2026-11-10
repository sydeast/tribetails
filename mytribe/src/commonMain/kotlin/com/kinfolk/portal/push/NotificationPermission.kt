package com.kinfolk.portal.push
import androidx.compose.runtime.Composable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
/**
 * Whether this device will actually show a push once one arrives (#1788). A
 * token can register fine and every push still be dropped, because Android 13
 * and later need POST_NOTIFICATIONS granted at runtime and the kinfolk can
 * also switch notifications off for the whole app in system settings.
 */
sealed interface NotificationPermissionState {
    /** The platform handles this itself (desktop, browser) or needs nothing: no card. */
    data object NotApplicable : NotificationPermissionState
    /** Pushes will show. */
    data object Granted : NotificationPermissionState
    /** Nothing refused yet, or the system will still show its dialog once more. The Enable card. */
    data object NotAsked : NotificationPermissionState
    /** Refused and the system dialog will not open again; only system settings can change it. */
    data object Denied : NotificationPermissionState
    /** Allowed for the app, then switched off in system settings. */
    data object DisabledInSettings : NotificationPermissionState
}
/** Platform seam for the notification permission. The Android actual lives in androidMain. */
interface NotificationPermissionGate {
    val state: StateFlow<NotificationPermissionState>
    /** Reads the permission again; call on resume so coming back from system settings updates the card. */
    fun refresh()
    /** Opens the system dialog. Only ever called from a tap on the Enable card. */
    fun requestPermission()
    /** Opens the app's notification page in system settings. */
    fun openSystemSettings()
}
/** The gate for platforms with nothing to ask. */
object NotApplicableNotificationGate : NotificationPermissionGate {
    override val state: StateFlow<NotificationPermissionState> =
        MutableStateFlow<NotificationPermissionState>(NotificationPermissionState.NotApplicable)
    override fun refresh() = Unit
    override fun requestPermission() = Unit
    override fun openSystemSettings() = Unit
}
/** The gate for the current platform, remembered for the composition. Android asks through the Activity. */
@Composable
expect fun rememberNotificationPermissionGate(): NotificationPermissionGate
/** First API level where POST_NOTIFICATIONS is a runtime permission. */
const val RUNTIME_NOTIFICATION_PERMISSION_SDK = 33
/**
 * Pure mapping from what Android reports to a [NotificationPermissionState].
 *
 * [askedBefore] is our own flag, set once the system dialog has answered, since
 * Android gives no direct "never asked" signal. [canAskAgain] is
 * shouldShowRequestPermissionRationale: true after a first refusal, false both
 * before any ask and after "don't ask again".
 */
fun mapNotificationPermission(
    sdkInt: Int,
    runtimeGranted: Boolean,
    notificationsEnabled: Boolean,
    askedBefore: Boolean,
    canAskAgain: Boolean,
): NotificationPermissionState {
    if (sdkInt >= RUNTIME_NOTIFICATION_PERMISSION_SDK && !runtimeGranted) {
        return if (!askedBefore || canAskAgain) NotificationPermissionState.NotAsked else NotificationPermissionState.Denied
    }
    return if (notificationsEnabled) NotificationPermissionState.Granted else NotificationPermissionState.DisabledInSettings
}
/**
 * Why a push cannot be shown right now, or null when it can. The FCM service
 * logs this instead of swallowing a SecurityException.
 */
fun notificationBlockReason(sdkInt: Int, runtimeGranted: Boolean, notificationsEnabled: Boolean): String? = when {
    sdkInt >= RUNTIME_NOTIFICATION_PERMISSION_SDK && !runtimeGranted -> "POST_NOTIFICATIONS not granted"
    !notificationsEnabled -> "notifications turned off in system settings"
    else -> null
}
/**
 * Which single card Home and Notification Settings draw for this device.
 * [On] and [SigningUp] are Notification Settings only (#1808): Home shows no
 * card for a device that is signed up or still signing up.
 */
enum class DevicePushCardKind { None, Enable, Blocked, TurnedOff, Finish, On, SigningUp }
/**
 * [showDeviceStatus] is true on Notification Settings, where the card is never
 * blank for a device that can take push: "on" once registerFcmToken succeeded,
 * "signing up" while it runs. "On" comes only from [DevicePushState.Registered],
 * never from "nothing failed", so [DevicePushState.Unknown] and
 * [DevicePushState.Unavailable] stay [DevicePushCardKind.None] there too.
 */
fun devicePushCardKind(
    permission: NotificationPermissionState,
    push: DevicePushState,
    showDeviceStatus: Boolean = false,
): DevicePushCardKind = when (permission) {
    NotificationPermissionState.NotAsked -> DevicePushCardKind.Enable
    NotificationPermissionState.Denied -> DevicePushCardKind.Blocked
    NotificationPermissionState.DisabledInSettings -> DevicePushCardKind.TurnedOff
    NotificationPermissionState.Granted, NotificationPermissionState.NotApplicable -> when {
        push is DevicePushState.Failed -> DevicePushCardKind.Finish
        !showDeviceStatus -> DevicePushCardKind.None
        push == DevicePushState.Registered -> DevicePushCardKind.On
        push == DevicePushState.Registering -> DevicePushCardKind.SigningUp
        else -> DevicePushCardKind.None
    }
}
