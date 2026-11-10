package com.kinfolk.portal.push
import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
private const val TAG = "KinfolkPush"
private const val PREFS = "notification_permission"
private const val KEY_ASKED = "asked"
/** True when this app may post a notification right now, with the reason when it may not. */
internal fun notificationBlockReasonNow(context: Context): String? = notificationBlockReason(
    sdkInt = Build.VERSION.SDK_INT,
    runtimeGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED,
    notificationsEnabled = NotificationManagerCompat.from(context).areNotificationsEnabled(),
)
/**
 * #1788: KinfolkFcmService reports each push it had to drop here instead of
 * swallowing the SecurityException. The gate listens, so a visible screen
 * re-reads the permission the moment a push is lost.
 */
object DroppedPushLog {
    private val _events = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val events: SharedFlow<String> = _events.asSharedFlow()
    private val _lastReason = MutableStateFlow<String?>(null)
    /** Why the most recent push was dropped, or null if none has been this process. */
    val lastReason: StateFlow<String?> = _lastReason.asStateFlow()
    fun record(reason: String) {
        _lastReason.value = reason
        _events.tryEmit(reason)
    }
}
internal class AndroidNotificationPermissionGate(
    private val context: Context,
    private val activity: Activity?,
) : NotificationPermissionGate {
    private val _state = MutableStateFlow(compute())
    override val state: StateFlow<NotificationPermissionState> = _state.asStateFlow()
    /** Set by the composable once the Activity result launcher exists. */
    var launcher: ((String) -> Unit)? = null
    private val prefs get() = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private fun compute(): NotificationPermissionState = mapNotificationPermission(
        sdkInt = Build.VERSION.SDK_INT,
        runtimeGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED,
        notificationsEnabled = NotificationManagerCompat.from(context).areNotificationsEnabled(),
        askedBefore = prefs.getBoolean(KEY_ASKED, false),
        canAskAgain = activity?.let {
            ActivityCompat.shouldShowRequestPermissionRationale(it, Manifest.permission.POST_NOTIFICATIONS)
        } ?: false,
    )
    override fun refresh() {
        _state.value = compute()
    }
    override fun requestPermission() {
        val start = launcher
        if (start == null || Build.VERSION.SDK_INT < RUNTIME_NOTIFICATION_PERMISSION_SDK) {
            // Nothing to ask (older Android) or no Activity to ask through: send them to settings.
            openSystemSettings()
            return
        }
        start(Manifest.permission.POST_NOTIFICATIONS)
    }
    /** The system dialog answered (granted or not). */
    fun onRequestResult() {
        prefs.edit().putBoolean(KEY_ASKED, true).apply()
        refresh()
    }
    override fun openSystemSettings() {
        val appSettings = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        val fallback = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))
        for (intent in listOf(appSettings, fallback)) {
            if (activity == null) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                context.startActivity(intent)
                return
            } catch (e: ActivityNotFoundException) {
                Log.w(TAG, "no screen for ${intent.action}", e)
            }
        }
    }
}
private fun Context.findActivity(): Activity? {
    var c: Context? = this
    while (c is ContextWrapper) {
        if (c is Activity) return c
        c = c.baseContext
    }
    return null
}
@Composable
actual fun rememberNotificationPermissionGate(): NotificationPermissionGate {
    val context = LocalContext.current
    val activity = remember(context) { context.findActivity() }
    val gate = remember(context) { AndroidNotificationPermissionGate(context.applicationContext, activity) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { gate.onRequestResult() }
    remember(launcher) { gate.launcher = { permission -> launcher.launch(permission) } }
    // Coming back from system settings (or the dialog) re-reads the permission.
    DisposableEffect(activity) {
        val owner = activity as? LifecycleOwner
        val observer = object : DefaultLifecycleObserver {
            override fun onResume(owner: LifecycleOwner) = gate.refresh()
        }
        owner?.lifecycle?.addObserver(observer)
        onDispose { owner?.lifecycle?.removeObserver(observer) }
    }
    LaunchedEffect(gate) {
        DroppedPushLog.events.collect { gate.refresh() }
    }
    return gate
}
