package com.tribetails.auntieos.ui.admin

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import com.tribetails.auntieos.data.admin.NotificationEntry
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.IncomingKinCare
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.ManageSeriesResult
import com.tribetails.auntieos.ui.admin.scheduling.IncomingSeries
import com.tribetails.auntieos.ui.admin.scheduling.LocalBusinessZone
import com.tribetails.auntieos.ui.admin.scheduling.groupIncomingBySeries
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * #1875: Approve and Deny on a "Kinfolk requested a KinCare visit" row acted at
 * once, and Deny told the household. Each now opens a confirm step that names
 * the household and the dates and says who is told; nothing is sent until it
 * is confirmed. #2028: Open on that row lands on the request's sheet on
 * Bookings, not on a visit lookup that cannot find it.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1080dp-h4000dp-xhdpi")
class NotificationRequestConfirmTest {

    @get:Rule
    val rule = createComposeRule()

    private lateinit var repo: AuntieRepository

    private val row = NotificationEntry(
        id = "n1",
        key = "kincare.requested",
        title = "Kinfolk requested a KinCare visit",
        targetType = "booking",
        targetId = "req_1",
        data = mapOf("kinfolkId" to "kf1", "kinfolkName" to "The Rowans"),
        createdAt = "2026-11-10T16:50:00Z",
    )

    private val series: IncomingSeries = groupIncomingBySeries(
        listOf(
            IncomingKinCare(
                familyId = "kf1", batchId = "req_1", visitId = "v1", kinfolkId = "kf1",
                kinfolkName = "The Rowans", serviceType = "Dog Walk",
                startTime = "2026-12-03T15:00:00Z", status = "requested", kinNames = listOf("Rex"),
            ),
        ),
    ).single()

    @Before
    fun setUp() {
        repo = mockk()
        coEvery { repo.getNotifications() } returns Result.success(listOf(row))
        coEvery { repo.getKinfolk() } returns Result.success(emptyList())
        coEvery { repo.manageBookingSeries(any(), any(), any(), any(), any(), any(), any()) } returns
            Result.success(ManageSeriesResult(affectedVisits = 1, failedVisits = 0, householdNotified = true, newlyConfirmed = 1))
    }

    private fun mount(
        pending: List<IncomingSeries>?,
        opened: MutableList<Pair<String, String>> = mutableListOf(),
        openedTarget: MutableList<String> = mutableListOf(),
    ) {
        val vm = AdminDataViewModel(
            repository = repo,
            invoiceRepository = mockk<InvoiceRepository>(),
            kinCareRepository = mockk<KinCareRepository>(),
        )
        rule.setContent {
            AuntieOSTheme {
                CompositionLocalProvider(LocalBusinessZone provides ZoneId.of("America/Chicago")) {
                    NotificationsScreen(
                        viewModel = vm,
                        onBack = {},
                        onOpenTarget = { _, id -> openedTarget += id },
                        pendingRequests = pending,
                        onOpenRequest = { kf, batch -> opened += kf to batch },
                        businessTimeZone = "America/Chicago",
                    )
                }
            }
        }
        rule.waitUntil(5_000) { rule.onAllNodesWithText("Kinfolk requested a KinCare visit").fetchSemanticsNodes().isNotEmpty() }
    }

    @Test
    fun denyAsksFirstAndNamesTheHouseholdTheDateAndWhoIsTold() {
        mount(listOf(series))
        rule.onNodeWithText("Deny").performClick()
        rule.onNodeWithText("Turn down this request from The Rowans").assertExists()
        rule.onNodeWithText("Thu, Dec 3", substring = true).assertExists()
        rule.onNodeWithText("Nothing will be booked. The household will be told.").assertExists()
        coVerify(exactly = 0) { repo.manageBookingSeries(any(), any(), any(), any(), any(), any(), any()) }

        rule.onNodeWithTag("householdNote").performTextInput("We are full that week.")
        rule.onNodeWithText("Turn it down").performClick()
        rule.waitForIdle()
        coVerify(exactly = 1) {
            repo.manageBookingSeries("CANCEL", "kf1", "req_1", any(), any(), any(), "We are full that week.")
        }
    }

    @Test
    fun approveAsksFirstAndNeverMindSendsNothing() {
        mount(listOf(series))
        rule.onNodeWithText("Approve").performClick()
        rule.onNodeWithText("Book this request for The Rowans").assertExists()
        rule.onNodeWithText("This visit will go on the schedule and on the household's portal.").assertExists()
        rule.onNodeWithText("Never mind").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Book this request for The Rowans").assertDoesNotExist()
        coVerify(exactly = 0) { repo.manageBookingSeries(any(), any(), any(), any(), any(), any(), any()) }
    }

    @Test
    fun openOnAWaitingRequestGoesToTheRequestNotAVisitLookup() {
        val opened = mutableListOf<Pair<String, String>>()
        val target = mutableListOf<String>()
        mount(listOf(series), opened, target)
        rule.onNodeWithText("Open").performClick()
        rule.waitForIdle()
        assertEquals(listOf("kf1" to "req_1"), opened)
        assertEquals(emptyList<String>(), target)
    }

    @Test
    fun whileTheQueueIsUnknownTheRowOffersOpenOnly() {
        mount(null)
        rule.onNodeWithText("Approve").assertDoesNotExist()
        rule.onNodeWithText("Deny").assertDoesNotExist()
        rule.onNodeWithText("Open").assertExists()
    }

    @Test
    fun anAnsweredRequestReadsAnsweredWithNoDecision() {
        mount(emptyList())
        rule.onNodeWithText("Approve").assertDoesNotExist()
        rule.onNodeWithText("Answered").assertExists()
    }
}
