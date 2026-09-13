package com.tribetails.auntieos.ui.directory

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * #809: the household profile's own Upcoming KinCare rows have to open the
 * session they name, same as the Kin detail screen's (#808) and the React
 * twin's (`KinfolkProfileFeeds.test.tsx`, `links[0]` -> `/sessions/s1`).
 *
 * `VisitLine`'s `onOpen` is a required parameter now (not a nullable default),
 * precisely so a screen cannot compile while forgetting to wire it the way
 * this one did.
 *
 * The tall qualifier gets the whole profile LazyColumn into composition on a
 * phone-height viewport; without it, Upcoming KinCare never enters composition
 * and the click assertion below would find nothing to click.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1080dp-h6000dp-xhdpi")
class KinfolkProfileVisitTest {

    @get:Rule
    val rule = createComposeRule()

    private val repository = mockk<AuntieRepository>(relaxed = true)
    private val invoiceRepository = mockk<InvoiceRepository>(relaxed = true)
    private val kinCareRepository = mockk<KinCareRepository>(relaxed = true)

    private val soon: String = Instant.now().plus(2, ChronoUnit.DAYS).toString()

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())

        coEvery { repository.getKinfolk() } returns
            Result.success(listOf(Kinfolk(id = "kf1", firstName = "Lorna", lastName = "Wren")))
        coEvery { repository.getAllKin() } returns Result.success(emptyList())
        coEvery { kinCareRepository.getKinCareSessions() } returns Result.success(emptyList())

        coEvery { repository.getDossier(any()) } returns Result.success(null)
        coEvery { repository.getKin(any()) } returns Result.success(emptyList())
        coEvery { kinCareRepository.getAllKinCareReports() } returns Result.success(emptyList())
        coEvery { invoiceRepository.getInvoicesForKinfolk(any()) } returns Result.success(emptyList())
        coEvery { repository.getHouseholdData(any()) } returns Result.success(null)
        coEvery { repository.getVetClinicsOnce() } returns Result.success(emptyList())
        coEvery { repository.listFormSchemas() } returns Result.success(emptyList())
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun show(onOpenVisit: (String) -> Unit = {}) {
        val vm = DirectoryViewModel(repository, invoiceRepository, kinCareRepository)
        vm.loadProfile("kf1")
        rule.setContent {
            AuntieOSTheme {
                KinfolkProfileScreen(
                    viewModel = vm,
                    kinfolkId = "kf1",
                    onBack = {},
                    onEdit = {},
                    onAddKin = { _, _ -> },
                    onOpenVisit = onOpenVisit,
                )
            }
        }
        rule.waitForIdle()
    }

    @Test
    fun `an upcoming visit row opens the session it names, not just any handler`() {
        coEvery { kinCareRepository.getKinCareSessionsForKinfolk("kf1") } returns Result.success(
            listOf(
                KinCareSession(
                    id = "s1", kinfolkId = "kf1", kinIds = listOf("k1"),
                    startTime = soon, serviceType = "Walk",
                    serviceDurationMinutes = 30, status = "SCHEDULED",
                ),
            ),
        )
        var opened: String? = null
        show(onOpenVisit = { opened = it })

        rule.onNodeWithText("Upcoming KinCare").assertIsDisplayed()
        rule.onNodeWithText("30-min walk").performClick()

        assertEquals("s1", opened)
    }

    @Test
    fun `two visits each open their OWN session, never each other's`() {
        val later = Instant.now().plus(3, ChronoUnit.DAYS).toString()
        coEvery { kinCareRepository.getKinCareSessionsForKinfolk("kf1") } returns Result.success(
            listOf(
                KinCareSession(
                    id = "s1", kinfolkId = "kf1", kinIds = listOf("k1"),
                    startTime = soon, serviceType = "Walk",
                    serviceDurationMinutes = 30, status = "SCHEDULED",
                ),
                KinCareSession(
                    id = "s2", kinfolkId = "kf1", kinIds = listOf("k1"),
                    startTime = later, serviceType = "Drop-in",
                    serviceDurationMinutes = 45, status = "SCHEDULED",
                ),
            ),
        )
        val openedIds = mutableListOf<String>()
        show(onOpenVisit = { openedIds.add(it) })

        rule.onNodeWithText("45-min drop-in").performClick()
        assertEquals(listOf("s2"), openedIds)

        rule.onNodeWithText("30-min walk").performClick()
        assertEquals(listOf("s2", "s1"), openedIds)
    }
}
