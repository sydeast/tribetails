package com.tribetails.auntieos.web.screens.sessions

import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.runDesktopComposeUiTest
import com.tribetails.auntieos.web.data.BusinessSettings
import com.tribetails.auntieos.web.data.JvmFirestoreFixtures
import com.tribetails.auntieos.web.data.KinCareSession
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.theme.AuntieAppTheme
import com.tribetails.auntieos.web.theme.ThemeMode
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * #2123 on the console's Auntie Time board, rendered. A DEPARTED card offers
 * Complete and "Send the KinTale" whether or not a tale was sent before; a
 * COMPLETED card with no sent tale offers "Send the KinTale", a sent one
 * "View KinTale". With "KinTale required" on, an owed visit is listed under
 * "KinTales to send", however old. Completing never waits on a KinTale.
 */
@OptIn(ExperimentalTestApi::class)
class AuntieTimeKinTaleRenderTest {

    @AfterTest
    fun tearDown() = JvmFirestoreFixtures.clear()

    private fun ComposeUiTest.show(
        sessions: List<KinCareSession>,
        settings: BusinessSettings = BusinessSettings(),
        onViewKinTale: (String) -> Unit = {},
        onWriteKinTale: (String) -> Unit = {},
    ) {
        JvmFirestoreFixtures.sessions = sessions
        JvmFirestoreFixtures.kinfolk = listOf(Kinfolk(_id = "kf1"))
        JvmFirestoreFixtures.allKin = emptyList()
        JvmFirestoreFixtures.businessSettings = settings
        JvmFirestoreFixtures.callableResponses = mapOf(
            "transitionBookingStatus" to
                """{"ok":true,"sessionId":"s1","action":"COMPLETE","from":"DEPARTED","status":"COMPLETED","changed":true}""",
        )
        setContent {
            AuntieAppTheme(themeMode = ThemeMode.DARK) {
                AuntieTimeListScreen(onOpenDetail = {}, onWriteKinTale = onWriteKinTale, onViewKinTale = onViewKinTale)
            }
        }
    }

    private fun ComposeUiTest.waitForText(text: String) =
        waitUntil(timeoutMillis = 10_000) { onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }

    private fun ComposeUiTest.count(text: String) = onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().size

    private fun hoursAgo(hours: Long): String =
        java.time.Instant.now().minusSeconds(hours * 3600).truncatedTo(java.time.temporal.ChronoUnit.SECONDS).toString()

    // Relative to now, not a fixed day: a COMPLETED visit is on the board only
    // until the day after it.
    private fun visit(status: String, id: String = "s1", startHoursAgo: Long = 3) = KinCareSession(
        _id = id,
        kinfolkId = "kf1",
        kinfolkName = "Whitfield",
        status = status,
        startTime = hoursAgo(startHoursAgo),
        arrivedAt = hoursAgo(startHoursAgo),
        departedAt = hoursAgo(startHoursAgo - 1),
    )

    @Test
    fun aDepartedCardOffersCompleteAndSendTheKinTale() = runDesktopComposeUiTest {
        show(listOf(visit("DEPARTED")))
        waitForText("Send the KinTale")
        assertEquals(1, count("Complete"))
        assertEquals(0, count("View KinTale"))
        assertEquals(0, count("Complete KinTale"))
    }

    @Test
    fun aDepartedCardWhoseKinTaleWentFirstOffersCompleteAndViewKinTale() = runDesktopComposeUiTest {
        show(listOf(visit("DEPARTED").copy(sentReportCount = 1, reportIds = listOf("r1"), autoCompleteEligible = true)))
        waitForText("View KinTale")
        assertEquals(1, count("Complete"))
        assertEquals(0, count("Send the KinTale"))
    }

    @Test
    fun completeOnADepartedCardWithNoKinTaleGoesThroughTransitionBookingStatus() = runDesktopComposeUiTest {
        show(listOf(visit("DEPARTED")))
        waitForText("Send the KinTale")
        onNodeWithText("Complete", useUnmergedTree = true).performClick()
        waitUntil(timeoutMillis = 10_000) { JvmFirestoreFixtures.callablePayloads.isNotEmpty() }
        val (name, json) = JvmFirestoreFixtures.callablePayloads.single()
        assertEquals("transitionBookingStatus", name)
        val payload = Json.parseToJsonElement(json).jsonObject
        assertEquals("s1", payload["sessionId"]?.jsonPrimitive?.content)
        assertEquals("COMPLETE", payload["action"]?.jsonPrimitive?.content)
        waitForText("Marked Completed.")
    }

    @Test
    fun aRefusedCompleteSaysWhyAndSendsNothing() = runDesktopComposeUiTest {
        JvmFirestoreFixtures.arrivalRuleRaw = true
        show(listOf(visit("DEPARTED").copy(arrivedAt = "")))
        waitForText("Send the KinTale")
        onNodeWithText("Complete", useUnmergedTree = true).performClick()
        waitUntil(timeoutMillis = 10_000) {
            onAllNodesWithText("Couldn't complete", substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
        }
        assertTrue(JvmFirestoreFixtures.callablePayloads.isEmpty())
    }

    @Test
    fun completeOnAScheduledCardCompletesTheVisitAndNeverOpensTheComposer() = runDesktopComposeUiTest {
        val written = mutableListOf<String>()
        show(listOf(visit("SCHEDULED").copy(startTime = hoursAgo(-2), arrivedAt = "", departedAt = "")), onWriteKinTale = { written += it })
        waitForText("Complete")
        onNodeWithText("Complete", useUnmergedTree = true).performClick()
        waitUntil(timeoutMillis = 10_000) { JvmFirestoreFixtures.callablePayloads.isNotEmpty() }
        assertEquals("transitionBookingStatus", JvmFirestoreFixtures.callablePayloads.single().first)
        assertTrue(written.isEmpty())
    }

    @Test
    fun sendTheKinTaleOnACompletedCardOpensTheComposer() = runDesktopComposeUiTest {
        val written = mutableListOf<String>()
        val viewed = mutableListOf<String>()
        show(listOf(visit("COMPLETED")), onWriteKinTale = { written += it }, onViewKinTale = { viewed += it })
        waitForText("Send the KinTale")
        onNodeWithText("Send the KinTale", useUnmergedTree = true).performClick()
        waitForIdle()
        assertEquals(listOf("s1"), written)
        assertTrue(viewed.isEmpty())
    }

    @Test
    fun aCompletedCardWithASentKinTaleOpensTheReportNotTheComposer() = runDesktopComposeUiTest {
        val viewed = mutableListOf<String>()
        val written = mutableListOf<String>()
        show(listOf(visit("COMPLETED").copy(sentReportCount = 1, reportIds = listOf("r1"))), onViewKinTale = { viewed += it }, onWriteKinTale = { written += it })
        waitForText("View KinTale")
        onNodeWithText("View KinTale", useUnmergedTree = true).performClick()
        waitForIdle()
        assertEquals(listOf("s1"), viewed)
        assertTrue(written.isEmpty())
        assertEquals(0, count("Send the KinTale"))
    }

    @Test
    fun withKinTaleRequiredAnOwedVisitFromLastMonthIsListedUnderKinTalesToSend() = runDesktopComposeUiTest {
        show(
            listOf(visit("COMPLETED", startHoursAgo = 24 * 30).copy(kinTaleDue = true)),
            settings = BusinessSettings(kinTaleRequired = true),
        )
        waitForText("KinTales to send")
        waitForText("Send the KinTale")
        assertEquals(0, count("Recent"))
    }

    @Test
    fun withKinTaleRequiredOffTheGroupIsGoneAndOnlyRecentVisitsShow() = runDesktopComposeUiTest {
        show(
            listOf(
                visit("COMPLETED", id = "s1").copy(kinTaleDue = true),
                visit("COMPLETED", id = "s2", startHoursAgo = 24 * 30).copy(kinTaleDue = true),
            ),
            settings = BusinessSettings(kinTaleRequired = false),
        )
        waitForText("Recent")
        assertEquals(0, count("KinTales to send"))
        assertEquals(1, count("Send the KinTale"))
    }

    @Test
    fun aBusinessThatNeverSavedKinTaleRequiredHasNoGroup() = runDesktopComposeUiTest {
        // Ruling 2026-11-13, "Start it off": a settings document without the key is off.
        show(listOf(visit("COMPLETED", id = "s1").copy(kinTaleDue = true)), settings = BusinessSettings(businessName = "Tribe Tails"))
        waitForText("Recent")
        assertEquals(0, count("KinTales to send"))
        assertEquals(1, count("Send the KinTale"))
    }
}
