package com.kinfolk.portal.push
import androidx.compose.runtime.Composable
/** The browser permission is asked inside obtainPushToken (the web portal has its own PushPrompt card). */
@Composable
actual fun rememberNotificationPermissionGate(): NotificationPermissionGate = NotApplicableNotificationGate
