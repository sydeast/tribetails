package com.kinfolk.portal.push
import androidx.compose.runtime.Composable
/** Desktop has no notification permission to ask for. */
@Composable
actual fun rememberNotificationPermissionGate(): NotificationPermissionGate = NotApplicableNotificationGate
