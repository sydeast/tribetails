@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.kin

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.components.RoutePoint
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.firebase.FirestoreClient
import com.kinfolk.portal.firebase.FirestoreDoc
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test

class KinScreenTest {

    /** Mirrors the kinProfile schema seeded in scripts/seedDemoKinfolk.ts. */
    private fun stubKinSchema(fake: FakeFunctionsClient) {
        fake.stub("getFormSchema", buildJsonObject {
            put("id", "kinProfile")
            put("name", "Kin Profile")
            put("version", 1)
            put("sections", buildJsonArray {
                add(buildJsonObject {
                    put("title", "Profile")
                    put("fields", buildJsonArray {
                        add(buildJsonObject { put("key", "species"); put("label", "Species (dog, cat, etc.)"); put("type", "text"); put("required", false) })
                        add(buildJsonObject { put("key", "breed"); put("label", "Breed"); put("type", "text"); put("required", false) })
                        add(buildJsonObject { put("key", "ageYears"); put("label", "Age (years)"); put("type", "number"); put("required", false) })
                    })
                })
                add(buildJsonObject {
                    put("title", "Care")
                    put("fields", buildJsonArray {
                        add(buildJsonObject { put("key", "feedingInstructions"); put("label", "Feeding Instructions"); put("type", "textarea"); put("required", false) })
                        add(buildJsonObject { put("key", "walkingInstructions"); put("label", "Walking Instructions"); put("type", "textarea"); put("required", false) })
                    })
                })
            })
        })
    }

    @Test
    fun addNewClick_withSchema_rendersSchemaDrivenSections() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKin", buildJsonObject { put("kin", buildJsonArray {}) })
        stubKinSchema(fake)
        setThemedContent { KinScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Add New").performClick()
        waitForIdle()
        // Section titles "Profile" + "Care" only render via the schema path.
        onNodeWithText("Care").assertExists()
        onNodeWithText("Feeding Instructions").assertExists()
        // Name stays a dedicated control above the schema fields.
        onNodeWithText("Name").assertExists()
    }

    @Test
    fun empty_rendersAddNewCallToAction() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKin", buildJsonObject { put("kin", buildJsonArray {}) })
        setThemedContent { KinScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("No Kin added yet").assertIsDisplayed()
        onNodeWithText("Add New").assertIsDisplayed()
    }

    @Test
    fun activeAndPassed_groupedSeparately() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKin", buildJsonObject {
            put("kin", buildJsonArray {
                add(buildJsonObject {
                    put("id", "k1")
                    put("name", "Buddy")
                    put("breed", "Aussie")
                    put("ageYears", 5.0)
                    put("status", "active")
                })
                add(buildJsonObject {
                    put("id", "k2")
                    put("name", "Old Boy")
                    put("status", "noLongerWithUs")
                })
            })
        })
        setThemedContent { KinScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Buddy").assertIsDisplayed()
        onNodeWithText("Old Boy").assertIsDisplayed()
        onNodeWithText("No Longer With Us").assertIsDisplayed()
        onNodeWithText("In our hearts").assertIsDisplayed()
    }

    @Test
    fun addNewClick_opensDialog() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKin", buildJsonObject { put("kin", buildJsonArray {}) })
        setThemedContent { KinScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Add New").performClick()
        waitForIdle()
        // "Add Kin" appears twice (title + confirm button) — assertExists handles both.
        onAllNodesWithText("Add Kin")[0].assertExists()
        onNodeWithText("Feeding Instructions").assertExists()
        onNodeWithText("Walking Instructions").assertExists()
    }

    @Test
    fun kinCardClick_firesOnOpenKin() = runComposeUiTest {
        // Detail selection is lifted into nav: tapping a card emits the id and
        // the host routes to KinDetailRoute (detail render covered in
        // KinDetailScreenTest).
        val fake = FakeFunctionsClient()
        fake.stub("getMyKin", buildJsonObject {
            put("kin", buildJsonArray {
                add(buildJsonObject {
                    put("id", "k1")
                    put("name", "Buddy")
                    put("status", "active")
                })
            })
        })
        var opened: String? = null
        setThemedContent { KinScreen("The Foster", "3", PortalApi(fake), onOpenKin = { opened = it }) }
        waitForIdle()
        onNodeWithText("Buddy").performClick()
        waitForIdle()
        kotlin.test.assertEquals("k1", opened)
    }

    @Test
    fun error_rendersFailureCard() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyKin", IllegalStateException("read failed"))
        setThemedContent { KinScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        onNodeWithText("Couldn't load Kin").assertIsDisplayed()
    }

    /** The household's own copies, read straight from `families/{id}/kin` (#1282). */
    private class HouseholdKin(private val docs: List<FirestoreDoc>) : FirestoreClient {
        override suspend fun getDocument(collection: String, documentId: String): Map<String, Any?>? = null
        override suspend fun listDocuments(collection: String): List<FirestoreDoc> = docs
        override fun breadcrumbsStream(sessionId: String): Flow<List<RoutePoint>> = flowOf(emptyList())
    }
    /**
     * #1492: a Kin the office archived (both copies now carry `archived`) is not
     * drawn on the household's roster; restored, it is drawn again.
     */
    @Test
    fun officeArchivedKin_isNotDrawn() = runComposeUiTest {
        val fs = HouseholdKin(
            listOf(
                FirestoreDoc("k1", mapOf("name" to "Buddy", "status" to "active")),
                FirestoreDoc("k2", mapOf("name" to "Pepper", "status" to "archived", "removalRequestId" to "3_k2")),
            ),
        )
        setThemedContent { KinScreen("The Foster", "3", PortalApi(FakeFunctionsClient(), fs)) }
        waitForIdle()
        onNodeWithText("Buddy").assertIsDisplayed()
        onAllNodesWithText("Pepper").assertCountEquals(0)
    }
    @Test
    fun officeRestoredKin_isDrawnAgain() = runComposeUiTest {
        val fs = HouseholdKin(
            listOf(
                FirestoreDoc("k1", mapOf("name" to "Buddy", "status" to "active")),
                FirestoreDoc("k2", mapOf("name" to "Pepper", "status" to "active")),
            ),
        )
        setThemedContent { KinScreen("The Foster", "3", PortalApi(FakeFunctionsClient(), fs)) }
        waitForIdle()
        onNodeWithText("Buddy").assertIsDisplayed()
        onNodeWithText("Pepper").assertIsDisplayed()
    }

    /** #1504: Add New opens the add form, and that tap wakes addKin. Each open is its own. */
    @Test
    fun addNew_warmsAddKin_onEachOpen() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKin", buildJsonObject { put("kin", buildJsonArray {}) })
        stubKinSchema(fake)
        setThemedContent { KinScreen("The Foster", "3", PortalApi(fake)) }
        waitForIdle()
        kotlin.test.assertEquals(emptyList<String>(), fake.warmCalls, "the list itself warms nothing")
        onNodeWithText("Add New").performClick()
        waitForIdle()
        kotlin.test.assertEquals(listOf("addKin"), fake.warmCalls)
    }
    /** The edit route wakes updateKin once its Kin has resolved. */
    @Test
    fun editRoute_warmsUpdateKinOnce() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stub("getMyKin", buildJsonObject {
            put("kin", buildJsonArray {
                add(buildJsonObject { put("id", "k1"); put("name", "Buddy"); put("status", "active") })
            })
        })
        stubKinSchema(fake)
        setThemedContent {
            val controller = rememberKinController("3", PortalApi(fake))
            androidx.compose.runtime.LaunchedEffect(Unit) { controller.reload() }
            KinAddEditScreen(kinId = "k1", controller = controller, onClose = {})
        }
        waitForIdle()
        kotlin.test.assertEquals(listOf("updateKin"), fake.warmCalls)
    }

    private fun oneKin(fake: FakeFunctionsClient) {
        fake.stub("getMyKin", buildJsonObject {
            put("kin", buildJsonArray {
                add(buildJsonObject { put("id", "k1"); put("name", "Buddy"); put("status", "active") })
            })
        })
    }
    /** A notice, Tribe or the Gallery opens a Kin before the Kin tab has read the roster. */
    @Test
    fun detailOpenedFirst_readsTheRoster_andShowsTheKin() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        oneKin(fake)
        setThemedContent {
            val controller = rememberKinController("3", PortalApi(fake))
            KinDetailHost("The Foster", "k1", controller, onBack = {}, onEdit = {})
        }
        waitForIdle()
        onAllNodesWithText("Buddy")[0].assertExists()
        onAllNodesWithText("Kin not found").assertCountEquals(0)
        kotlin.test.assertEquals(1, fake.calls.count { it.first == "getMyKin" })
    }
    @Test
    fun detailForAKinNoLongerListed_saysSoAfterReading() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        oneKin(fake)
        setThemedContent {
            val controller = rememberKinController("3", PortalApi(fake))
            KinDetailHost("The Foster", "gone", controller, onBack = {}, onEdit = {})
        }
        waitForIdle()
        onNodeWithText("Kin not found").assertIsDisplayed()
    }
    @Test
    fun detailWhenTheRosterCannotBeRead_saysSo() = runComposeUiTest {
        val fake = FakeFunctionsClient()
        fake.stubError("getMyKin", IllegalStateException("read failed"))
        setThemedContent {
            val controller = rememberKinController("3", PortalApi(fake))
            KinDetailHost("The Foster", "k1", controller, onBack = {}, onEdit = {})
        }
        waitForIdle()
        onNodeWithText("Couldn't load Kin").assertIsDisplayed()
        onAllNodesWithText("Kin not found").assertCountEquals(0)
    }
}
