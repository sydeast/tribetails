@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)
package com.kinfolk.portal.screens.schedule
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
/** #1285 / #1303: a visit that is over has no note box, and points at what it left behind. */
class CompletedVisitDetailTest {
    private val fixedNow = 1_700_000_000_000L
    private fun stub(
        fake: FakeFunctionsClient,
        status: String = "completed",
        kinTaleId: String? = "tale-9",
        invoiceId: String? = "inv-3",
        address: String? = "12 Elm St, Austin TX",
    ) {
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray {})
            put("recent", buildJsonArray {
                add(buildJsonObject {
                    put("id", "b1")
                    put("kinfolkId", "3")
                    put("batchId", "batch-1")
                    put("status", status)
                    put("title", "Park Adventure")
                    put("serviceType", "Drop-in Visit")
                    put("startTimeMs", fixedNow - 86_400_000L)
                    put("sessionId", "sess-1")
                    kinTaleId?.let { put("kinTaleId", it) }
                    invoiceId?.let { put("invoiceId", it) }
                    address?.let { put("address", it) }
                })
            })
        })
        fake.stub("getMyVisits", buildJsonObject { put("visits", buildJsonArray {}) })
    }
    private fun androidx.compose.ui.test.ComposeUiTest.show(
        fake: FakeFunctionsClient,
        onTales: () -> Unit = {},
        onInvoice: (String) -> Unit = {},
    ) {
        setThemedContent {
            KinCareDetailScreen(
                kinCareId = "b1",
                kinfolkId = "3",
                portalApi = PortalApi(fake),
                onBack = {},
                nowMs = { fixedNow },
                onOpenKinTales = onTales,
                onOpenInvoice = onInvoice,
            )
        }
        waitForIdle()
    }
    @Test
    fun completedVisit_hasNoNoteBox() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stub(fake)
        show(fake)
        onNodeWithText("Additional Information").assertDoesNotExist()
        onNodeWithText("Save Note").assertDoesNotExist()
    }
    @Test
    fun cancelledVisit_hasNoNoteBox() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stub(fake, status = "cancelled")
        show(fake)
        onNodeWithText("Additional Information").assertDoesNotExist()
    }
    @Test
    fun completedVisit_showsAddress() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stub(fake)
        show(fake)
        onNodeWithText("12 Elm St, Austin TX").assertIsDisplayed()
    }
    @Test
    fun completedVisit_linksToItsKinTaleAndInvoice() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stub(fake)
        var tales = 0
        val invoices = mutableListOf<String>()
        show(fake, onTales = { tales++ }, onInvoice = { invoices += it })
        onNodeWithText("Read the KinTale").performClick()
        onNodeWithText("See the invoice").performClick()
        assertEquals(1, tales)
        assertEquals(listOf("inv-3"), invoices)
    }
    @Test
    fun completedVisit_offersNoLinkToARecordThatDoesNotExist() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        stub(fake, kinTaleId = null, invoiceId = null)
        show(fake)
        onNodeWithText("Read the KinTale").assertDoesNotExist()
        onNodeWithText("See the invoice").assertDoesNotExist()
        onNodeWithText("Nothing has been sent for this visit yet.").assertIsDisplayed()
    }
}
