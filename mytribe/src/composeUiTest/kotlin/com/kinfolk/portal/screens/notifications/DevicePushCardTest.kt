@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)
package com.kinfolk.portal.screens.notifications
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.push.DevicePushState
import com.kinfolk.portal.push.NotificationPermissionGate
import com.kinfolk.portal.push.NotificationPermissionState
import com.kinfolk.portal.push.PushRegistrationCoordinator
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.json.buildJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
/** #1788: the notifications card for each permission state, on its own and wired to the gate. */
class DevicePushCardTest {
    private class FakeGate(initial: NotificationPermissionState) : NotificationPermissionGate {
        val flow = MutableStateFlow(initial)
        override val state: StateFlow<NotificationPermissionState> = flow
        var refreshes = 0
        var requests = 0
        var settingsOpened = 0
        override fun refresh() { refreshes += 1 }
        override fun requestPermission() { requests += 1 }
        override fun openSystemSettings() { settingsOpened += 1 }
    }
    private fun coordinator(gate: NotificationPermissionGate, token: suspend () -> String? = { "tok-1" }) =
        PushRegistrationCoordinator(
            portalApi = PortalApi(FakeFunctionsClient().apply { stub("registerFcmToken", buildJsonObject {}) }),
            platform = "test-mytribe",
            tokenProvider = token,
            logger = {},
            permissionGate = gate,
        )
    @Test
    fun notAsked_showsTheEnableCard_andOnlyTheTapOpensTheDialog() = runComposeUiTest {
        val gate = FakeGate(NotificationPermissionState.NotAsked)
        val c = coordinator(gate)
        setThemedContent { DevicePushCard(c, onDismiss = null) }
        waitForIdle()
        onNodeWithText("Get notified about visits").assertExists()
        onNodeWithText("Know the moment your Auntie checks in, sends a KinTale, or replies to a message.").assertExists()
        assertEquals(0, gate.requests)
        onNodeWithTag("device-push-enable").assertTextEquals("Enable notifications")
        onNodeWithTag("device-push-enable").performClick()
        assertEquals(1, gate.requests)
    }
    @Test
    fun denied_showsBlocked_andTheButtonOpensSystemSettings() = runComposeUiTest {
        val gate = FakeGate(NotificationPermissionState.Denied)
        val c = coordinator(gate)
        setThemedContent { DevicePushCard(c, onDismiss = null) }
        waitForIdle()
        onNodeWithText("Notifications are blocked").assertExists()
        onNodeWithTag("device-push-blocked-body").assertTextEquals(
            "To get them, open your phone's notification settings for MyTribe and turn on Allow notifications. Then come back here.",
        )
        onNodeWithTag("device-push-open-settings").assertTextEquals("Open notification settings")
        onNodeWithTag("device-push-open-settings").performClick()
        assertEquals(1, gate.settingsOpened)
        assertEquals(0, gate.requests)
    }
    @Test
    fun switchedOffInSystemSettings_showsItsOwnSentence_andTheSameButton() = runComposeUiTest {
        val gate = FakeGate(NotificationPermissionState.DisabledInSettings)
        val c = coordinator(gate)
        setThemedContent { DevicePushCard(c, onDismiss = null) }
        waitForIdle()
        onNodeWithTag("device-push-blocked-body").assertTextEquals(
            "Notifications are turned off for MyTribe in your phone's settings. Turn them back on to hear about visits.",
        )
        onNodeWithTag("device-push-open-settings").performClick()
        assertEquals(1, gate.settingsOpened)
    }
    @Test
    fun returningFromSettings_clearsTheCard() = runComposeUiTest {
        val gate = FakeGate(NotificationPermissionState.Denied)
        val c = coordinator(gate)
        setThemedContent { DevicePushCard(c, onDismiss = null) }
        waitForIdle()
        onNodeWithTag("device-push-card").assertExists()
        gate.flow.value = NotificationPermissionState.Granted
        waitForIdle()
        onNodeWithTag("device-push-card").assertDoesNotExist()
    }
    @Test
    fun grantedAndRegistered_showsNoCard_andTheCardReadsThePermissionOnAppearing() = runComposeUiTest {
        val gate = FakeGate(NotificationPermissionState.Granted)
        val c = coordinator(gate)
        c.onSignedIn()
        setThemedContent { DevicePushCard(c, onDismiss = null) }
        waitForIdle()
        onNodeWithTag("device-push-card").assertDoesNotExist()
        assertEquals(1, gate.refreshes)
    }
    @Test
    fun notApplicablePlatform_showsNoCard() = runComposeUiTest {
        val gate = FakeGate(NotificationPermissionState.NotApplicable)
        val c = coordinator(gate)
        setThemedContent { DevicePushCard(c, onDismiss = null) }
        waitForIdle()
        onNodeWithTag("device-push-card").assertDoesNotExist()
    }
    @Test
    fun grantedButTheTokenFailed_keepsTheFinishCardAndRetry() = runComposeUiTest {
        val gate = FakeGate(NotificationPermissionState.Granted)
        var fail = true
        val c = coordinator(gate, token = { if (fail) throw IllegalStateException("SERVICE_NOT_AVAILABLE") else "tok-1" })
        c.onSignedIn()
        setThemedContent { DevicePushCard(c, onDismiss = null) }
        waitForIdle()
        onNodeWithText("Finish turning on notifications").assertExists()
        fail = false
        onNodeWithTag("device-push-retry").performClick()
        waitForIdle()
        onNodeWithTag("device-push-card").assertDoesNotExist()
    }
    @Test
    fun blockedWinsOverAFailedToken_soThereIsOneCard() = runComposeUiTest {
        val gate = FakeGate(NotificationPermissionState.Denied)
        val c = coordinator(gate, token = { throw IllegalStateException("down") })
        c.onSignedIn()
        setThemedContent { DevicePushCard(c, onDismiss = null) }
        waitForIdle()
        onNodeWithText("Notifications are blocked").assertExists()
        onNodeWithTag("device-push-retry").assertDoesNotExist()
    }
    @Test
    fun onHome_maybeLaterHidesTheCardForTheSession() = runComposeUiTest {
        val gate = FakeGate(NotificationPermissionState.NotAsked)
        val c = coordinator(gate)
        setThemedContent {
            DevicePushCard(c, onDismiss = { c.dismissHomeCard() })
        }
        waitForIdle()
        onNodeWithTag("device-push-dismiss").assertTextEquals("Maybe later")
        onNodeWithTag("device-push-dismiss").performClick()
        assertEquals(true, c.homeCardDismissed.value)
    }
    @Test
    fun onHome_theBlockedCardClosesWithClose() = runComposeUiTest {
        val gate = FakeGate(NotificationPermissionState.Denied)
        val c = coordinator(gate)
        setThemedContent { DevicePushCard(c, onDismiss = { c.dismissHomeCard() }) }
        waitForIdle()
        onNodeWithTag("device-push-dismiss").assertTextEquals("Close")
    }
    @Test
    fun onNotificationSettings_thereIsNoDismissButton() = runComposeUiTest {
        val gate = FakeGate(NotificationPermissionState.NotAsked)
        val c = coordinator(gate)
        setThemedContent { DevicePushCard(c, onDismiss = null) }
        waitForIdle()
        onNodeWithTag("device-push-dismiss").assertDoesNotExist()
    }

    // ---- #1808: Notification Settings says what this device is doing ----
    private fun ComposeUiTest.has(tag: String): Boolean = onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()

    @Test
    fun onNotificationSettings_aSignedUpDeviceSaysNotificationsAreOn() = runComposeUiTest {
        val gate = FakeGate(NotificationPermissionState.Granted)
        val c = coordinator(gate)
        c.onSignedIn()
        setThemedContent { DevicePushCard(c, onDismiss = null, showDeviceStatus = true) }
        waitForIdle()
        onNodeWithTag("device-push-on").assertTextEquals("Notifications are on for this device.")
        onNodeWithTag("device-push-retry").assertDoesNotExist()
        onNodeWithTag("device-push-enable").assertDoesNotExist()
        onNodeWithTag("device-push-dismiss").assertDoesNotExist()
    }
    @Test
    fun onHome_aSignedUpDeviceShowsNoCard() = runComposeUiTest {
        val gate = FakeGate(NotificationPermissionState.Granted)
        val c = coordinator(gate)
        c.onSignedIn()
        setThemedContent { DevicePushCard(c, onDismiss = { c.dismissHomeCard() }) }
        waitForIdle()
        onNodeWithTag("device-push-card").assertDoesNotExist()
        onNodeWithText("Notifications are on for this device.").assertDoesNotExist()
    }
    @Test
    fun onNotificationSettings_aSignUpInFlightSaysSigningUpWithASpinner_thenOn() = runComposeUiTest {
        val gate = FakeGate(NotificationPermissionState.Granted)
        val release = CompletableDeferred<String?>()
        val c = coordinator(gate, token = { release.await() })
        val signIn = CoroutineScope(Dispatchers.Default).launch { c.onSignedIn() }
        setThemedContent { DevicePushCard(c, onDismiss = null, showDeviceStatus = true) }
        waitUntil(timeoutMillis = 5_000) { has("device-push-signing-up") }
        onNodeWithTag("device-push-signing-up").assertTextEquals("Signing up this device…")
        onNodeWithTag("device-push-spinner").assertExists()
        onNodeWithTag("device-push-on").assertDoesNotExist()
        onNodeWithTag("device-push-dismiss").assertDoesNotExist()
        release.complete("tok-1")
        waitUntil(timeoutMillis = 5_000) { has("device-push-on") }
        onNodeWithTag("device-push-signing-up").assertDoesNotExist()
        signIn.cancel()
    }
    @Test
    fun onHome_aSignUpInFlightShowsNoCard() = runComposeUiTest {
        val gate = FakeGate(NotificationPermissionState.Granted)
        val release = CompletableDeferred<String?>()
        val c = coordinator(gate, token = { release.await() })
        val signIn = CoroutineScope(Dispatchers.Default).launch { c.onSignedIn() }
        setThemedContent { DevicePushCard(c, onDismiss = { c.dismissHomeCard() }) }
        waitUntil(timeoutMillis = 5_000) { c.state.value == DevicePushState.Registering }
        waitForIdle()
        onNodeWithTag("device-push-card").assertDoesNotExist()
        release.complete("tok-1")
        signIn.cancel()
    }
    @Test
    fun onNotificationSettings_retryFromTheFinishCardSaysSigningUp_thenOn() = runComposeUiTest {
        val gate = FakeGate(NotificationPermissionState.Granted)
        var next: suspend () -> String? = { throw IllegalStateException("SERVICE_NOT_AVAILABLE") }
        val c = coordinator(gate, token = { next() })
        c.onSignedIn()
        setThemedContent { DevicePushCard(c, onDismiss = null, showDeviceStatus = true) }
        waitForIdle()
        onNodeWithText("Finish turning on notifications").assertExists()
        val release = CompletableDeferred<String?>()
        next = { release.await() }
        onNodeWithTag("device-push-retry").performClick()
        waitUntil(timeoutMillis = 5_000) { has("device-push-signing-up") }
        release.complete("tok-1")
        waitUntil(timeoutMillis = 5_000) { has("device-push-on") }
        onNodeWithText("Finish turning on notifications").assertDoesNotExist()
    }
    @Test
    fun onNotificationSettings_aPlatformWithNoTokenStillShowsNoCard() = runComposeUiTest {
        val gate = FakeGate(NotificationPermissionState.NotApplicable)
        val c = coordinator(gate, token = { null })
        c.onSignedIn()
        setThemedContent { DevicePushCard(c, onDismiss = null, showDeviceStatus = true) }
        waitForIdle()
        onNodeWithTag("device-push-card").assertDoesNotExist()
    }
}
