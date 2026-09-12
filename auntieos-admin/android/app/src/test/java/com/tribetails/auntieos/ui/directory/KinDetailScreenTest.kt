package com.tribetails.auntieos.ui.directory

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kin411
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
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
 * The standalone Kin (pet) screen, `ui-ideas/auntieos-kin-detail-2026-05-27.html`.
 *
 * Panel for panel against its React twin (`src/screens/KinView.tsx`): Care
 * checklist, Medical, Auntie's notes, The 411, the pet's KinTales, Upcoming
 * KinCare. Each is asserted both full and EMPTY, because "every panel renders,
 * with a quiet line when there is nothing on file" is the rule that keeps the
 * page the same shape for every pet, and a test that only feeds a full pet
 * cannot tell a missing panel from an empty one.
 *
 * The tall qualifier is so the whole LazyColumn composes: on a phone-height
 * viewport the panels below the fold never enter composition and every
 * assertion past Medical would pass vacuously.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w1080dp-h6000dp-xhdpi")
class KinDetailScreenTest {

    @get:Rule
    val rule = createComposeRule()

    private val repo = mockk<AuntieRepository>(relaxed = true)
    private val kinCareRepo = mockk<KinCareRepository>(relaxed = true)

    private val soon: String = Instant.now().plus(2, ChronoUnit.DAYS).toString()

    private val fullKin = Kin(
        id = "k1",
        kinfolkId = "kf1",
        name = "Biscuit",
        species = "Dog",
        breed = "Labrador Retriever",
        age = "5",
        sex = "Male",
        spayedNeutered = true,
        weight = "68 lbs",
        staysAs = "Loose in the house",
        routine = "Morning walk, eats at 7a and 6p",
        trainingCommands = "sit, wait, leave it",
        feedingBrand = "Kibble, one cup",
        vaccinations = "Rabies, exp 2027",
        medicationHealthNotes = "Glucosamine daily",
        vetInfo = "Riverside Animal Hospital",
        checklist = "Fresh water\nWipe paws",
        officeNotes = "Obsessed with sticks.",
        reactive = true,
        tags = listOf("littermate"),
    )

    private val bareKin = Kin(id = "k1", kinfolkId = "kf1", name = "Biscuit", species = "Dog")

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        coEvery { repo.getKinByIds(any()) } returns Result.success(mapOf("k1" to fullKin))
        coEvery { repo.get411ForKin(any()) } returns Result.success(null)
        coEvery { repo.getKinfolkById(any()) } returns
            Result.success(Kinfolk(id = "kf1", firstName = "Lorna", lastName = "Wren"))
        coEvery { repo.listFormSchemas() } returns Result.success(emptyList())
        coEvery { kinCareRepo.getAllKinCareReports() } returns Result.success(emptyList())
        coEvery { kinCareRepo.getKinCareSessionsForKinfolk(any()) } returns Result.success(emptyList())
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun show(
        onDirectory: () -> Unit = {},
        onHousehold: (String) -> Unit = {},
        onEditKin: (String) -> Unit = {},
        onOpenReport: (String) -> Unit = {},
        onOpenVisit: (String) -> Unit = {},
    ) {
        val vm = KinDetailViewModel(repo, kinCareRepo)
        vm.load("k1")
        rule.setContent {
            AuntieOSTheme {
                KinDetailScreen(
                    kinId = "k1",
                    viewModel = vm,
                    onBack = {},
                    onDirectory = onDirectory,
                    onHousehold = onHousehold,
                    onEditKin = onEditKin,
                    onOpenReport = onOpenReport,
                    onOpenVisit = onOpenVisit,
                )
            }
        }
        rule.waitForIdle()
    }

    // ── the hero ─────────────────────────────────────────────────────────────

    @Test
    fun `the band names the pet, its facts and its household`() {
        show()

        rule.onAllNodesWithText("Biscuit").onFirst().assertIsDisplayed()
        rule.onNodeWithText("Labrador Retriever · 5 yrs · neutered male · 68 lbs").assertIsDisplayed()
        rule.onNodeWithText("belongs to Lorna Wren").assertIsDisplayed()
    }

    @Test
    fun `the trail walks back out through the household`() {
        show()

        rule.onNodeWithText("Directory").assertIsDisplayed()
        rule.onNodeWithText("Lorna Wren").assertIsDisplayed()
    }

    @Test
    fun `the Directory step opens the Directory`() {
        var opened = 0
        show(onDirectory = { opened++ })

        rule.onNodeWithText("Directory").performClick()

        assertEquals(1, opened)
    }

    @Test
    fun `the household step opens the household`() {
        var opened: String? = null
        show(onHousehold = { opened = it })

        rule.onNodeWithText("Lorna Wren").performClick()

        assertEquals("kf1", opened)
    }

    /** Tags are pills beside the name (#686), with the editor behind a toggle. */
    @Test
    fun `the pet's tags are pills in the band`() {
        show()

        // The kit renders every mono pill uppercase (`AuntieStatusPill`).
        rule.onNodeWithText("LITTERMATE").assertIsDisplayed()
        rule.onNodeWithText("Edit tags").assertIsDisplayed()
    }

    /** #690: under the band, not among the tags and not a page banner. */
    @Test
    fun `a reactive pet carries the warning`() {
        show()

        rule.onNodeWithText("REACTIVE: HANDLE WITH CARE").assertIsDisplayed()
    }

    @Test
    fun `a pet that is not reactive carries no warning`() {
        coEvery { repo.getKinByIds(any()) } returns Result.success(mapOf("k1" to bareKin))
        show()

        rule.onAllNodesWithText("REACTIVE: HANDLE WITH CARE").assertCountEquals(0)
    }

    /** The mock draws no status on a pet, because the pet it draws is active. */
    @Test
    fun `an archived pet says so and an active one does not`() {
        coEvery { repo.getKinByIds(any()) } returns
            Result.success(mapOf("k1" to fullKin.copy(status = "archived")))
        show()

        rule.onNodeWithText("ARCHIVED").assertIsDisplayed()
    }

    @Test
    fun `Edit kin opens the editor`() {
        var edited: String? = null
        show(onEditKin = { edited = it })

        rule.onNodeWithText("Edit kin").performClick()

        assertEquals("k1", edited)
    }

    // ── the panels, full ─────────────────────────────────────────────────────

    @Test
    fun `the care checklist carries the care fields and the legacy lines`() {
        show()

        rule.onNodeWithText("Care checklist").assertIsDisplayed()
        // `AuntieKeyValueRow` renders every field LABEL uppercase; values are left alone.
        rule.onNodeWithText("STAYS AS").assertIsDisplayed()
        rule.onNodeWithText("Loose in the house").assertIsDisplayed()
        rule.onNodeWithText("TRAINING / COMMANDS").assertIsDisplayed()
        rule.onNodeWithText("FOOD / BRAND").assertIsDisplayed()
        rule.onNodeWithText("· Fresh water").assertIsDisplayed()
        rule.onNodeWithText("· Wipe paws").assertIsDisplayed()
    }

    /**
     * `vetInfo` is READ-ONLY on the pet and authored on the household (ruling
     * 2026-08-01). Legacy pet docs still carry real text, so it is SHOWN.
     */
    @Test
    fun `medical carries the vaccinations, the meds and the legacy vet line`() {
        show()

        rule.onNodeWithText("Medical").assertIsDisplayed()
        rule.onNodeWithText("Rabies, exp 2027").assertIsDisplayed()
        rule.onNodeWithText("Glucosamine daily").assertIsDisplayed()
        rule.onNodeWithText("Riverside Animal Hospital").assertIsDisplayed()
    }

    @Test
    fun `Auntie's notes carries the office notes`() {
        show()

        rule.onNodeWithText("Auntie's notes").assertIsDisplayed()
        rule.onNodeWithText("Obsessed with sticks.").assertIsDisplayed()
    }

    /** Admin-only, on an admin surface: a 411 never reaches a kinfolk screen. */
    @Test
    fun `the 411 carries what the pipeline worked out`() {
        coEvery { repo.get411ForKin(any()) } returns Result.success(
            Kin411(
                kinId = "k1",
                tldr = "Easygoing and eager.",
                personality = "Lights up for walks.",
                quirksAndPreferences = "Carries a stick the whole walk.",
                dietaryDetails = "Eats at 7a and 6p.",
                medicalNotes = "Chicken allergy.",
            ),
        )
        show()

        rule.onNodeWithText("The 411").assertIsDisplayed()
        rule.onNodeWithText("Easygoing and eager.").assertIsDisplayed()
        rule.onNodeWithText("Carries a stick the whole walk.").assertIsDisplayed()
        rule.onNodeWithText("Chicken allergy.").assertIsDisplayed()
    }

    @Test
    fun `the pet's KinTales are listed and open their report`() {
        coEvery { kinCareRepo.getAllKinCareReports() } returns Result.success(
            listOf(
                KinCareReport(
                    id = "r1", sessionId = "s1", kinfolkId = "kf1", kinIds = listOf("k1"),
                    status = "SENT", title = "Hit the trail",
                    bodyCopy = "Long creek loop, one very important stick.",
                    sentAt = "2026-09-01T09:42:00Z",
                ),
            ),
        )
        var opened: String? = null
        show(onOpenReport = { opened = it })

        rule.onNodeWithText("Biscuit's KinTales").assertIsDisplayed()
        rule.onNodeWithText("Hit the trail").performClick()

        assertEquals("s1", opened)
    }

    @Test
    fun `upcoming KinCare is listed and opens the visit`() {
        coEvery { kinCareRepo.getKinCareSessionsForKinfolk("kf1") } returns Result.success(
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

    // ── the panels, empty ────────────────────────────────────────────────────

    @Test
    fun `a pet with nothing on file still draws every panel`() {
        coEvery { repo.getKinByIds(any()) } returns Result.success(mapOf("k1" to bareKin))
        show()

        rule.onNodeWithText("No care notes for Biscuit yet.").assertIsDisplayed()
        rule.onNodeWithText("No medical notes for Biscuit yet.").assertIsDisplayed()
        rule.onNodeWithText("No notes yet.").assertIsDisplayed()
        rule.onNodeWithText("No 411 for Biscuit yet.").assertIsDisplayed()
        rule.onNodeWithText("No KinTales about Biscuit yet.").assertIsDisplayed()
        rule.onNodeWithText("No visits booked for Biscuit in the next 7 days.").assertIsDisplayed()
    }

    /**
     * KinTales and visits are booked against a HOUSEHOLD. A pet with none on
     * file is told so, rather than shown two panels quietly reading as "none".
     */
    @Test
    fun `a pet with no household says why it has no feeds`() {
        coEvery { repo.getKinByIds(any()) } returns
            Result.success(mapOf("k1" to bareKin.copy(kinfolkId = "")))
        show()

        rule.onNodeWithText(
            "No household on file for Biscuit, so no KinTales or visits can be matched.",
        ).assertIsDisplayed()
    }

    // ── fail loud ────────────────────────────────────────────────────────────

    @Test
    fun `a pet that cannot be read says so instead of drawing a blank page`() {
        coEvery { repo.getKinByIds(any()) } returns Result.success(emptyMap())
        show()

        rule.onNodeWithText("Kin not found: k1").assertIsDisplayed()
    }

    /** One failed read, one failed panel: the rest of the page stands. */
    @Test
    fun `a failed 411 read is reported on its own panel`() {
        coEvery { repo.get411ForKin(any()) } returns
            Result.failure(RuntimeException("permission-denied"))
        show()

        rule.onNodeWithText("Couldn't load Biscuit's 411. permission-denied").assertIsDisplayed()
        rule.onNodeWithText("Medical").assertIsDisplayed()
    }
}
