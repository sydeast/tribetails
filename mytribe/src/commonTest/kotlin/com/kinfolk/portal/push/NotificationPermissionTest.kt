package com.kinfolk.portal.push
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
/** #1788: how what Android reports becomes the one card a kinfolk sees. */
class NotificationPermissionTest {
    private fun map(
        sdk: Int = 35,
        granted: Boolean = false,
        enabled: Boolean = true,
        asked: Boolean = false,
        canAskAgain: Boolean = false,
    ) = mapNotificationPermission(sdk, granted, enabled, asked, canAskAgain)
    @Test
    fun `a fresh install on Android 13 or later has not been asked`() {
        assertEquals(NotificationPermissionState.NotAsked, map())
    }
    @Test
    fun `granted and switched on is Granted`() {
        assertEquals(NotificationPermissionState.Granted, map(granted = true, asked = true))
    }
    @Test
    fun `one refusal still lets the system dialog open again`() {
        assertEquals(NotificationPermissionState.NotAsked, map(asked = true, canAskAgain = true))
    }
    @Test
    fun `dont ask again is Denied`() {
        assertEquals(NotificationPermissionState.Denied, map(asked = true, canAskAgain = false))
    }
    @Test
    fun `permission pulled in system settings after a grant is Denied`() {
        assertEquals(NotificationPermissionState.Denied, map(granted = false, asked = true))
    }
    @Test
    fun `granted but notifications switched off for the app is DisabledInSettings`() {
        assertEquals(NotificationPermissionState.DisabledInSettings, map(granted = true, enabled = false, asked = true))
    }
    @Test
    fun `before Android 13 there is no prompt, so only the system switch matters`() {
        assertEquals(NotificationPermissionState.Granted, map(sdk = 32, granted = false, enabled = true))
        assertEquals(NotificationPermissionState.DisabledInSettings, map(sdk = 32, granted = false, enabled = false))
    }
    @Test
    fun `Android 13 exactly is the first runtime permission`() {
        assertEquals(NotificationPermissionState.NotAsked, map(sdk = 33))
        assertEquals(NotificationPermissionState.Granted, map(sdk = 32))
    }
    @Test
    fun `block reason names the missing permission`() {
        assertEquals("POST_NOTIFICATIONS not granted", notificationBlockReason(35, runtimeGranted = false, notificationsEnabled = true))
    }
    @Test
    fun `block reason names the system switch`() {
        assertEquals("notifications turned off in system settings", notificationBlockReason(35, true, false))
        assertEquals("notifications turned off in system settings", notificationBlockReason(32, false, false))
    }
    @Test
    fun `no block reason when a push can show`() {
        assertNull(notificationBlockReason(35, true, true))
        assertNull(notificationBlockReason(32, false, true))
    }
    @Test
    fun `card kind follows the permission first and the registration second`() {
        val failed = DevicePushState.Failed("token", "X: y")
        assertEquals(DevicePushCardKind.Enable, devicePushCardKind(NotificationPermissionState.NotAsked, DevicePushState.Registered))
        assertEquals(DevicePushCardKind.Enable, devicePushCardKind(NotificationPermissionState.NotAsked, failed))
        assertEquals(DevicePushCardKind.Blocked, devicePushCardKind(NotificationPermissionState.Denied, failed))
        assertEquals(DevicePushCardKind.TurnedOff, devicePushCardKind(NotificationPermissionState.DisabledInSettings, DevicePushState.Registered))
        assertEquals(DevicePushCardKind.Finish, devicePushCardKind(NotificationPermissionState.Granted, failed))
        assertEquals(DevicePushCardKind.Finish, devicePushCardKind(NotificationPermissionState.NotApplicable, failed))
        assertEquals(DevicePushCardKind.None, devicePushCardKind(NotificationPermissionState.Granted, DevicePushState.Registered))
        assertEquals(DevicePushCardKind.None, devicePushCardKind(NotificationPermissionState.Granted, DevicePushState.Unavailable))
        assertEquals(DevicePushCardKind.None, devicePushCardKind(NotificationPermissionState.NotApplicable, DevicePushState.Unknown))
    }
}
