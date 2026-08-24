package com.tribetails.auntieos.ui.directory

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.ui.Screen
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
 * "New KinTale" on the household profile (#552).
 *
 * The mock (`auntieos-admin/ui-ideas/auntieos-kinfolk-profile-2026-05-27.html`,
 * the hero's `act primary`) put this button here, and #407 fixed every other
 * difference on both surfaces but not this one, because on Android it had
 * nowhere to go. What is pinned here is that it is present, and that it hands
 * back the HOUSEHOLD it was pressed on rather than a hardcoded or empty id.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1440dp-h2400dp-xhdpi")
class KinfolkProfileNewKinTaleTest {

    @get:Rule
    val compose = createComposeRule()

    @Before fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())
    @After fun tearDown() = Dispatchers.resetMain()

    private val kinfolk = Kinfolk(
        id = "kf1",
        firstName = "Lorna",
        lastName = "Wren",
        phoneNumber = "8055550100",
        email = "lorna@example.com",
        status = "active",
    )

    private fun buildVm(): DirectoryViewModel {
        val repo = mockk<AuntieRepository>(relaxed = true)
        val invoices = mockk<InvoiceRepository>(relaxed = true)
        val kinCare = mockk<KinCareRepository>(relaxed = true)
        coEvery { repo.getKinfolk() } returns Result.success(listOf(kinfolk))
        coEvery { repo.getAllKin() } returns Result.success(emptyList())
        coEvery { repo.getKin("kf1") } returns Result.success(emptyList())
        coEvery { repo.getDossier("kf1") } returns Result.success(null)
        coEvery { repo.getHouseholdData("kf1") } returns Result.success(null)
        coEvery { repo.getVetClinicsOnce() } returns Result.success(emptyList())
        coEvery { kinCare.getKinCareSessions() } returns Result.success(emptyList())
        coEvery { kinCare.getKinCareSessionsForKinfolk("kf1") } returns Result.success(emptyList())
        coEvery { kinCare.getAllKinCareReports() } returns Result.success(emptyList())
        coEvery { invoices.getInvoicesForKinfolk("kf1") } returns Result.success(emptyList())
        val vm = DirectoryViewModel(repo, invoices, kinCare)
        vm.loadDirectory()
        return vm
    }

    @Test
    fun `the hero offers New KinTale and hands back this household`() {
        var opened: String? = null
        val vm = buildVm()
        compose.setContent {
            AuntieOSTheme(themeMode = ThemeMode.DARK) {
                KinfolkProfileScreen(
                    viewModel = vm,
                    kinfolkId = "kf1",
                    onBack = {},
                    onEdit = {},
                    onAddKin = { _, _ -> },
                    onNewKinTale = { opened = it },
                )
            }
        }

        compose.onNodeWithText("New KinTale").performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("New KinTale").performClick()

        assertEquals("kf1", opened)
    }

    /**
     * The route the callback above is wired to in `Navigation.kt`. It is pinned
     * separately because the narrowing lives IN the route: a "New KinTale" that
     * navigated without the household would open every household's visits, which
     * is the exact defect the React side shipped with (its `kinfolkId` prop was
     * spread into a picker that never read it).
     */
    @Test
    fun `the New KinTale route carries the household, and omits it when there is none`() {
        assertEquals("kintale_new?kinfolkId=kf1", Screen.NewKinTale.createRoute("kf1"))
        assertEquals("kintale_new", Screen.NewKinTale.createRoute(null))
        assertEquals("kintale_new", Screen.NewKinTale.createRoute(""))
    }
}
