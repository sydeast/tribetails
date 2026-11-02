@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.home

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.firebase.FunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #1462: Home's Balance due line. Drawn only when the household owes
 * something, only for a member with billing access (`AppNavHost` passes
 * `onOpenInvoices = null` without it), and it opens Invoices.
 */
class HomeScreenBalanceDueTest {

    private fun stub(fake: FakeFunctionsClient, balanceDueCents: Long?) {
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {})
            put("recent", buildJsonArray {})
        })
        fake.stub("getMyHome", buildJsonObject {
            put("kinfolkId", "demo-1")
            put("displayName", "The Foster")
            put("billingAccess", true)
            // Null leaves the field out, as an older server does.
            if (balanceDueCents != null) put("balanceDueCents", balanceDueCents)
        })
    }

    @Test
    fun owed_showsBalanceDue_andOpensInvoices() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stub(fake, 4250)
        var opened = 0
        setThemedContent {
            HomeScreen("The Foster", "demo-1", PortalApi(fake), onOpenInvoices = { opened += 1 })
        }
        waitForIdle()
        onNodeWithText("BALANCE DUE").assertIsDisplayed()
        onNodeWithText("$42.50").assertIsDisplayed()
        onNodeWithText("BALANCE DUE").performClick()
        waitForIdle()
        assertEquals(1, opened)
    }

    /** The read has a visible cue while it runs, like every other wait on Home. */
    @Test
    fun whileReading_showsTheLoadingCue() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stub(fake, 4250)
        val gate = CompletableDeferred<Unit>()
        val slowHome = object : FunctionsClient {
            override suspend fun call(name: String, payload: JsonObject?): JsonObject {
                if (name == "getMyHome") gate.await()
                return fake.call(name, payload)
            }
        }
        setThemedContent {
            HomeScreen("The Foster", "demo-1", PortalApi(slowHome), onOpenInvoices = {})
        }
        waitForIdle()
        onNodeWithText("Checking your balance\u2026").assertExists()
        onNodeWithText("BALANCE DUE").assertDoesNotExist()
        gate.complete(Unit)
        waitForIdle()
        onNodeWithText("Checking your balance\u2026").assertDoesNotExist()
        onNodeWithText("BALANCE DUE").assertIsDisplayed()
    }

    @Test
    fun nothingOwed_drawsNoLine() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stub(fake, 0)
        setThemedContent {
            HomeScreen("The Foster", "demo-1", PortalApi(fake), onOpenInvoices = {})
        }
        waitForIdle()
        assertTrue(fake.calls.any { it.first == "getMyHome" })
        onNodeWithText("BALANCE DUE").assertDoesNotExist()
        onNodeWithText("Checking your balance…").assertDoesNotExist()
    }

    @Test
    fun olderServerWithoutTheField_drawsNoLine() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stub(fake, null)
        setThemedContent {
            HomeScreen("The Foster", "demo-1", PortalApi(fake), onOpenInvoices = {})
        }
        waitForIdle()
        onNodeWithText("BALANCE DUE").assertDoesNotExist()
    }

    @Test
    fun noBillingAccess_neitherReadsNorDrawsTheBalance() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stub(fake, 4250)
        setThemedContent {
            HomeScreen("The Foster", "demo-1", PortalApi(fake), onOpenInvoices = null)
        }
        waitForIdle()
        onNodeWithText("BALANCE DUE").assertDoesNotExist()
        onNodeWithText("$42.50").assertDoesNotExist()
        assertTrue(fake.calls.none { it.first == "getMyHome" }, "no balance read without billing access: ${fake.calls.map { it.first }}")
    }
}
