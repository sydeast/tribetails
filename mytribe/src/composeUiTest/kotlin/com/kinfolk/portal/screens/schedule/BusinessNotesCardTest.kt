@file:OptIn(androidx.compose.ui.test.ExperimentalTestApi::class)

package com.kinfolk.portal.screens.schedule

import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.runComposeUiTest
import com.kinfolk.portal.firebase.FakeFunctionsClient
import com.kinfolk.portal.portal.PortalApi
import com.kinfolk.portal.screens.setThemedContent
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test

/**
 * #2030 on the MyTribe app: the note the office wrote on Accept, the note it
 * wrote on Decline and a kinfolk-facing visit note are on the visit's screen,
 * in their own card, each with what it was about and who wrote it. The web
 * mirror is the `#2030` block in `BookingDetail.test.tsx`.
 */
class BusinessNotesCardTest {
    private val now = kotlin.time.Clock.System.now().toEpochMilliseconds()

    private fun visit(status: String): JsonObject = buildJsonObject {
        put("id", "v1")
        put("kinfolkId", "3")
        put("batchId", "batch-1")
        put("status", status)
        put("visitProgress", JsonNull)
        put("serviceType", "visit_30")
        put("serviceLabel", "30 Minute Quick Check")
        put("startTimeMs", now + 3 * 86_400_000L)
        put("auntieDisplayName", "Maya")
        put("kinNames", buildJsonArray { add("Biscuit") })
    }

    private fun fake(v: JsonObject, fromBusiness: kotlinx.serialization.json.JsonArray): FakeFunctionsClient {
        val finished = v["status"].toString().trim('"') == "cancelled"
        val fake = FakeFunctionsClient()
        fake.stub("getMyBookings", buildJsonObject {
            put("liveVisit", JsonNull)
            put("upcoming", buildJsonArray { if (!finished) add(v) })
            put("recent", buildJsonArray { if (finished) add(v) })
            put("envelopes", buildJsonArray {
                add(buildJsonObject { put("batchId", "batch-1"); put("kinCares", buildJsonArray { add(v) }) })
            })
        })
        fake.stub("getMyVisits", buildJsonObject { put("visits", buildJsonArray {}) })
        fake.stub("getBookingNotes", buildJsonObject {
            put("bookingNote", JsonNull)
            put("notes", buildJsonArray {
                add(buildJsonObject { put("id", "own"); put("body", "Thanks so much"); put("createdAtMs", now - 1_000L) })
            })
            put("fromBusiness", fromBusiness)
        })
        return fake
    }

    private fun note(id: String, kind: String, body: String, author: String?) = buildJsonObject {
        put("id", id); put("kind", kind); put("body", body); put("createdAtMs", now - 60_000L)
        if (author == null) put("authorName", JsonNull) else put("authorName", author)
    }

    @Test
    fun booked_visit_shows_the_accept_note_and_the_visit_note_in_their_own_card() = runComposeUiTest {
        val f = fake(
            visit("confirmed"),
            buildJsonArray {
                add(note("request-accepted", "requestAccepted", "Booked. Bring the spare key.", "Syd"))
                add(note("n9", "visitNote", "Treats are on the shelf.", null))
            },
        )
        setThemedContent {
            KinCareDetailScreen(kinCareId = "v1", kinfolkId = "3", portalApi = PortalApi(f), onBack = {}, nowMs = { now })
        }
        waitUntil(5_000) { onAllNodes(hasTestTag("businessNotes")).fetchSemanticsNodes().isNotEmpty() }

        onNodeWithTag("businessNotes").assertExists()
        onNodeWithText("Booked. Bring the spare key.").assertExists()
        onNodeWithText("Booked · Syd", substring = true).assertExists()
        onNodeWithText("Treats are on the shelf.").assertExists()
        // No staff name to show: the business is named instead.
        onNodeWithText("Note · your Auntie", substring = true).assertExists()
        // The household's own note stays in its own card.
        onNodeWithText("Thanks so much").assertExists()
    }

    @Test
    fun declined_request_shows_the_decline_note() = runComposeUiTest {
        val f = fake(
            visit("cancelled"),
            buildJsonArray { add(note("request-declined", "requestDeclined", "We are full that week.", "Syd")) },
        )
        setThemedContent {
            KinCareDetailScreen(kinCareId = "v1", kinfolkId = "3", portalApi = PortalApi(f), onBack = {}, nowMs = { now })
        }
        waitUntil(5_000) { onAllNodes(hasTestTag("businessNotes")).fetchSemanticsNodes().isNotEmpty() }

        onNodeWithTag("businessNotes").assertExists()
        onNodeWithText("We are full that week.").assertExists()
        onNodeWithText("Not booked · Syd", substring = true).assertExists()
    }

    @Test
    fun no_card_when_the_office_wrote_nothing() = runComposeUiTest {
        val f = fake(visit("confirmed"), buildJsonArray {})
        setThemedContent {
            KinCareDetailScreen(kinCareId = "v1", kinfolkId = "3", portalApi = PortalApi(f), onBack = {}, nowMs = { now })
        }
        waitUntil(5_000) { onAllNodes(hasTestTag("savedNotes")).fetchSemanticsNodes().isNotEmpty() }
        waitForIdle()
        onNodeWithTag("businessNotes").assertDoesNotExist()
    }
}
