package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kin411
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import io.mockk.CapturingSlot
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * The Kin detail screen's reads.
 *
 * The load-bearing ones are the COLD ARRIVAL (this screen is reachable from the
 * Directory's Kin tab with nothing loaded behind it, which is the case the old
 * `profileState.kinList` lookup could not serve at all) and the NARROWING (a
 * household's KinTales and visits, kept to the rows that cover this pet).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class KinDetailViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private val repo = mockk<AuntieRepository>(relaxed = true)
    private val kinCareRepo = mockk<KinCareRepository>(relaxed = true)

    private val biscuit = Kin(
        id = "k1",
        kinfolkId = "kf1",
        name = "Biscuit",
        species = "Dog",
        breed = "Labrador Retriever",
        age = "5",
        sex = "Male",
        spayedNeutered = true,
        weight = "68 lbs",
        officeNotes = "Obsessed with sticks.",
        tags = listOf("reactive"),
    )

    private val wrens = Kinfolk(id = "kf1", firstName = "Lorna", lastName = "Wren")

    /** Inside the "next 7 days" window whichever day this suite runs. */
    private val soon: String = Instant.now().plus(2, ChronoUnit.DAYS).toString()

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        coEvery { repo.getKinByIds(any()) } returns Result.success(mapOf(biscuit.id to biscuit))
        coEvery { repo.get411ForKin(any()) } returns Result.success(null)
        coEvery { repo.getKinfolkById(any()) } returns Result.success(wrens)
        coEvery { repo.listFormSchemas() } returns Result.success(emptyList())
        coEvery { repo.updateKinFields(any(), any(), any()) } returns Result.success(Unit)
        coEvery { kinCareRepo.getAllKinCareReports() } returns Result.success(emptyList())
        coEvery { kinCareRepo.getKinCareSessionsForKinfolk(any()) } returns Result.success(emptyList())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun viewModel() = KinDetailViewModel(repo, kinCareRepo)

    private fun captureKinChanges(): CapturingSlot<Map<String, Any>> {
        val changes = slot<Map<String, Any>>()
        coEvery { repo.updateKinFields(any(), any(), capture(changes)) } returns Result.success(Unit)
        return changes
    }

    // ── the pet itself ───────────────────────────────────────────────────────

    /**
     * BY DOCUMENT ID, not out of a list some other screen happened to load.
     * That is the whole reason this screen has its own view model.
     */
    @Test
    fun `the pet is fetched by id with nothing loaded behind it`() = runTest(testDispatcher) {
        val vm = viewModel()

        vm.load("k1")
        advanceUntilIdle()

        val state = vm.uiState.value
        assertEquals("Biscuit", state.kin?.name)
        assertEquals("Lorna Wren", state.householdName)
        assertEquals("kf1", state.householdId)
        assertNull(state.error)
        coVerify { repo.getKinByIds(listOf("k1")) }
    }

    /** A pet that is not there FAILS LOUD rather than rendering an empty page. */
    @Test
    fun `a pet that cannot be read says so`() = runTest(testDispatcher) {
        coEvery { repo.getKinByIds(any()) } returns Result.success(emptyMap())
        val vm = viewModel()

        vm.load("ghost")
        advanceUntilIdle()

        assertNull(vm.uiState.value.kin)
        assertEquals("Kin not found: ghost", vm.uiState.value.error)
    }

    @Test
    fun `a blank id is refused without a read`() = runTest(testDispatcher) {
        val vm = viewModel()

        vm.load("")
        advanceUntilIdle()

        assertEquals("No kin id to open.", vm.uiState.value.error)
        coVerify(exactly = 0) { repo.getKinByIds(any()) }
    }

    /**
     * A 411 that fails must say so ON ITS OWN PANEL while the rest of the page
     * stands. Four reads, four verdicts, not one banner over the whole screen.
     */
    @Test
    fun `a failed 411 read does not take the page down with it`() = runTest(testDispatcher) {
        coEvery { repo.get411ForKin(any()) } returns Result.failure(RuntimeException("permission-denied"))
        val vm = viewModel()

        vm.load("k1")
        advanceUntilIdle()

        val state = vm.uiState.value
        assertNotNull("the pet must still render", state.kin)
        assertNull(state.error)
        assertEquals("permission-denied", state.kin411Error)
    }

    @Test
    fun `the pet's own 411 is read`() = runTest(testDispatcher) {
        coEvery { repo.get411ForKin("k1") } returns Result.success(
            Kin411(kinId = "k1", personality = "Easygoing and eager."),
        )
        val vm = viewModel()

        vm.load("k1")
        advanceUntilIdle()

        assertEquals("Easygoing and eager.", vm.uiState.value.kin411?.personality)
    }

    // ── the feeds, narrowed to this pet ──────────────────────────────────────

    @Test
    fun `KinTales about another pet in the same home are left out`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.getAllKinCareReports() } returns Result.success(
            listOf(
                KinCareReport(
                    id = "r1", sessionId = "s1", kinfolkId = "kf1", kinIds = listOf("k1"),
                    status = "SENT", title = "Hit the trail", sentAt = "2026-09-01T09:42:00Z",
                ),
                KinCareReport(
                    id = "r2", sessionId = "s2", kinfolkId = "kf1", kinIds = listOf("k9"),
                    status = "SENT", title = "The cat's day", sentAt = "2026-09-02T09:42:00Z",
                ),
            ),
        )
        val vm = viewModel()

        vm.load("k1")
        advanceUntilIdle()

        assertEquals(listOf("Hit the trail"), vm.uiState.value.tales.map { it.title })
        assertEquals(1, vm.uiState.value.taleCount)
    }

    /** R1 again: a pre-roster row names no pets and still belongs to this one. */
    @Test
    fun `a legacy KinTale naming no pets still counts as this pet's`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.getAllKinCareReports() } returns Result.success(
            listOf(
                KinCareReport(
                    id = "r1", sessionId = "s1", kinfolkId = "kf1", kinIds = emptyList(),
                    status = "SENT", title = "Before the roster", sentAt = "2026-01-02T09:42:00Z",
                ),
            ),
        )
        val vm = viewModel()

        vm.load("k1")
        advanceUntilIdle()

        assertEquals(listOf("Before the roster"), vm.uiState.value.tales.map { it.title })
    }

    @Test
    fun `upcoming visits are narrowed to this pet`() = runTest(testDispatcher) {
        coEvery { kinCareRepo.getKinCareSessionsForKinfolk("kf1") } returns Result.success(
            listOf(
                KinCareSession(
                    id = "s1", kinfolkId = "kf1", kinIds = listOf("k1"),
                    startTime = soon, serviceType = "Walk", status = "SCHEDULED",
                ),
                KinCareSession(
                    id = "s2", kinfolkId = "kf1", kinIds = listOf("k9"),
                    startTime = soon, serviceType = "Drop-in", status = "SCHEDULED",
                ),
            ),
        )
        val vm = viewModel()

        vm.load("k1")
        advanceUntilIdle()

        assertEquals(listOf("s1"), vm.uiState.value.upcomingVisits.map { it.id })
    }

    /**
     * A pet with no household on file has no feed to narrow: KinTales and visits
     * are booked against a household. The screen says so rather than reading as
     * "none", and no household-scoped query goes out on a blank id.
     */
    @Test
    fun `a pet with no household reads no household feeds`() = runTest(testDispatcher) {
        coEvery { repo.getKinByIds(any()) } returns
            Result.success(mapOf("k1" to biscuit.copy(kinfolkId = "")))
        val vm = viewModel()

        vm.load("k1")
        advanceUntilIdle()

        assertEquals("", vm.uiState.value.householdId)
        assertTrue(vm.uiState.value.upcomingVisits.isEmpty())
        coVerify(exactly = 0) { kinCareRepo.getKinCareSessionsForKinfolk(any()) }
    }

    // ── the one write on this screen ─────────────────────────────────────────

    /**
     * ONE FIELD. The whole-model save is the bug `DirectoryFieldChanges.kt`
     * documents: adding a tag used to write back every field the phone had read,
     * reverting anything corrected on the web in between, and a `Kin` rebuilt
     * from screen state wrote Kotlin defaults over the fields no control
     * carried. Tagging a pet must not be able to touch its medication note.
     */
    @Test
    fun `saving tags writes the tag list and nothing else`() = runTest(testDispatcher) {
        val changes = captureKinChanges()
        val vm = viewModel()
        vm.load("k1")
        advanceUntilIdle()

        vm.saveTags("k1", "kf1", listOf("reactive", "senior"))
        advanceUntilIdle()

        assertEquals(setOf("tags"), changes.captured.keys)
        assertEquals(listOf("reactive", "senior"), changes.captured["tags"])
        coVerify(exactly = 1) { repo.updateKinFields("k1", "kf1", any()) }
    }

    @Test
    fun `a saved tag list is reflected on the screen without a reload`() = runTest(testDispatcher) {
        val vm = viewModel()
        vm.load("k1")
        advanceUntilIdle()

        vm.saveTags("k1", "kf1", listOf("senior"))
        advanceUntilIdle()

        assertEquals(listOf("senior"), vm.uiState.value.kin?.tagNames())
    }

    /** Fail-loud: a rejected tag write throws, which is what reverts the chip. */
    @Test(expected = RuntimeException::class)
    fun `a rejected tag write throws`() = runTest(testDispatcher) {
        coEvery { repo.updateKinFields(any(), any(), any()) } returns
            Result.failure(RuntimeException("permission-denied"))
        val vm = viewModel()
        vm.load("k1")
        advanceUntilIdle()

        vm.saveTags("k1", "kf1", listOf("senior"))
    }
}
