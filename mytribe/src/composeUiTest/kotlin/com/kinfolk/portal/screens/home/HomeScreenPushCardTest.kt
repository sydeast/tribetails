@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)
package com.kinfolk.portal.screens.home
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.push.NotificationPermissionGate
import com.kinfolk.portal.push.NotificationPermissionState
import com.kinfolk.portal.push.PushRegistrationCoordinator
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
/** #1788: Home carries the same notifications card as the web portal's home. */
class HomeScreenPushCardTest {
    private class Gate(initial: NotificationPermissionState) : NotificationPermissionGate {
        override val state = MutableStateFlow(initial)
        var requests = 0
        override fun refresh() = Unit
        override fun requestPermission() { requests += 1 }
        override fun openSystemSettings() = Unit
    }
    private fun fake() = FakeFunctionsClient().apply {
        stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {})
            put("recent", buildJsonArray {})
        })
        stub("getMyHome", buildJsonObject {
            put("kinfolkId", "demo-1")
            put("displayName", "The Foster")
        })
    }
    @Test
    fun enableCardShowsOnHome_andMaybeLaterHidesIt() = runComposeUiTest {
        val fake = fake()
        val gate = Gate(NotificationPermissionState.NotAsked)
        val coordinator = PushRegistrationCoordinator(PortalApi(fake), "test-mytribe", tokenProvider = { "t" }, logger = {}, permissionGate = gate)
        setThemedContent { HomeScreen("The Foster", "demo-1", PortalApi(fake), pushCoordinator = coordinator) }
        waitForIdle()
        onNodeWithText("Get notified about visits").assertExists()
        onNodeWithTag("device-push-enable").performClick()
        assertEquals(1, gate.requests)
        onNodeWithTag("device-push-dismiss").performClick()
        waitForIdle()
        onNodeWithTag("device-push-card").assertDoesNotExist()
    }
    @Test
    fun noCoordinator_noCard() = runComposeUiTest {
        val fake = fake()
        setThemedContent { HomeScreen("The Foster", "demo-1", PortalApi(fake)) }
        waitForIdle()
        onNodeWithTag("device-push-card").assertDoesNotExist()
    }
}
