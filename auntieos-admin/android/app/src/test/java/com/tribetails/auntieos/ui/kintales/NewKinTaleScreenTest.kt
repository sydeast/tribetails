package com.tribetails.auntieos.ui.kintales

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.ui.theme.AuntieOSTheme
import com.tribetails.auntieos.ui.theme.ThemeMode
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

/**
 * The picker as the operator meets it (#552): the rows it offers, what tapping
 * one hands back, and the two bare states it must not confuse.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1440dp-h2400dp-xhdpi")
class NewKinTaleScreenTest {

    @get:Rule
    val compose = createComposeRule()

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    private fun session(
        id: String,
        status: String = "DEPARTED",
        serviceType: String = "Dog Walk",
        kinfolkName: String = "The Whitfields",
        kinfolkId: String = "kf1",
    ) = KinCareSession(
        id = id,
        kinfolkId = kinfolkId,
        kinfolkName = kinfolkName,
        serviceType = serviceType,
        startTime = "2026-07-16T14:00:00.000Z",
        status = status,
    )

    private fun mount(
        kinfolkId: String,
        result: Result<List<KinCareSession>>,
        onPickSession: (String) -> Unit = {},
    ) {
        val repo = mockk<KinCareRepository>()
        coEvery { repo.getKinCareSessionsForKinfolk(any()) } returns result
        coEvery { repo.getKinCareSessions() } returns result
        val vm = NewKinTaleViewModel(repo)
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                NewKinTaleScreen(
                    kinfolkId = kinfolkId,
                    onBack = {},
                    onPickSession = onPickSession,
                    viewModel = vm,
                )
            }
        }
    }

    @Test
    fun `it offers the household s eligible visits and names the household`() {
        mount("kf1", Result.success(listOf(session("s1"), session("s2", status = "SCHEDULED"))))

        compose.onNodeWithText("New KinTale").assertIsDisplayed()
        compose.onNodeWithText("Which visit is this about?").assertIsDisplayed()
        compose.onNodeWithText("Visits for The Whitfields that have already happened.").assertIsDisplayed()
        // Scoped, the SERVICE leads: every row is the same household.
        compose.onNodeWithText("Dog Walk").assertIsDisplayed()
    }

    @Test
    fun `tapping a visit hands its session id to the composer`() {
        var picked: String? = null
        mount("kf1", Result.success(listOf(session("s1")))) { picked = it }

        compose.onNodeWithText("Dog Walk").performClick()

        assertEquals("s1", picked)
    }

    @Test
    fun `a household with no eligible visit says so, and offers no row to tap`() {
        mount("kf1", Result.success(listOf(session("s1", status = "SCHEDULED"))))

        compose.onNodeWithText("No visits to write up yet").assertIsDisplayed()
        compose.onNodeWithText(
            "This household has no departed or completed visit to recap. Once a visit ends, it shows up here.",
        ).assertIsDisplayed()
    }

    @Test
    fun `a failed read is not an empty household, and the operator gets a retry`() {
        mount("kf1", Result.failure(IllegalStateException("offline")))

        compose.onNodeWithText("Couldn't load visits").assertIsDisplayed()
        compose.onNodeWithText("Couldn't load visits: offline").assertIsDisplayed()
        compose.onNodeWithText("Retry").assertIsDisplayed()
        // The empty-state copy must not be what a failure renders.
        compose.onNodeWithText("No visits to write up yet").assertDoesNotExist()
    }

    @Test
    fun `unscoped, the household leads each row instead of the service`() {
        mount(
            "",
            Result.success(
                listOf(
                    session("s1", kinfolkName = "The Whitfields", kinfolkId = "kf1"),
                    session("s2", kinfolkName = "The Alvarez Household", kinfolkId = "kf2"),
                ),
            ),
        )

        compose.onNodeWithText("The Whitfields").assertIsDisplayed()
        compose.onNodeWithText("The Alvarez Household").assertIsDisplayed()
        compose.onNodeWithText("A KinTale always starts from a visit that has already happened.")
            .assertIsDisplayed()
    }
}
