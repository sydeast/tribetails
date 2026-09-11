package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.ui.components.AuntieStatusTone
import com.tribetails.auntieos.util.SortOption
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * The Directory's Sort pill (#755, the screen matched to its mock) and the
 * card's corner badge. The mock draws a Sort pill beside the search on the
 * controls row and the web admin has carried one since the port; these pin the
 * Android half: the four orders on the Kinfolk tab, the three with a backing
 * field on the Kin tab, and the rule for when a card wears a badge at all.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DirectorySortTest {

    private val testDispatcher = UnconfinedTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun household(
        id: String,
        first: String,
        last: String,
        joinDate: String = "",
        updatedAt: String = "",
    ) = Kinfolk(id = id, firstName = first, lastName = last, status = "active", joinDate = joinDate, updatedAt = updatedAt)

    private fun kin(id: String, name: String, updatedAt: String = "") =
        Kin(id = id, name = name, species = "Dog", updatedAt = updatedAt)

    // ── Kinfolk tab ─────────────────────────────────────────────────────────

    /** 03-directory item 3 still holds: A to Z is by surname, first name breaking ties. */
    @Test
    fun `A to Z orders households by surname with a first-name tiebreak`() {
        val rows = listOf(
            household("1", "Zed", "Young"),
            household("2", "Bea", "Adams"),
            household("3", "Amy", "Adams"),
        )
        assertEquals(listOf("3", "2", "1"), sortKinfolkDirectory(rows, SortOption.AlphaAsc).map { it.id })
    }

    @Test
    fun `Z to A is A to Z reversed`() {
        val rows = listOf(
            household("1", "Zed", "Young"),
            household("2", "Bea", "Adams"),
            household("3", "Amy", "Adams"),
        )
        assertEquals(listOf("1", "2", "3"), sortKinfolkDirectory(rows, SortOption.AlphaDesc).map { it.id })
    }

    /** `joinDate` is the household's creation field, the same one the web admin reads. */
    @Test
    fun `Recently Created puts the newest join date first`() {
        val rows = listOf(
            household("1", "Amy", "Adams", joinDate = "2026-01-05"),
            household("2", "Bea", "Brook", joinDate = "2026-03-01"),
            household("3", "Cal", "Cole", joinDate = "2025-12-30"),
        )
        assertEquals(listOf("2", "1", "3"), sortKinfolkDirectory(rows, SortOption.RecentlyCreated).map { it.id })
    }

    @Test
    fun `Recently Updated puts the newest updatedAt first`() {
        val rows = listOf(
            household("1", "Amy", "Adams", updatedAt = "2026-07-01T00:00:00Z"),
            household("2", "Bea", "Brook", updatedAt = "2026-09-01T00:00:00Z"),
            household("3", "Cal", "Cole"),
        )
        assertEquals(listOf("2", "1", "3"), sortKinfolkDirectory(rows, SortOption.RecentlyUpdated).map { it.id })
    }

    // ── Kin tab ─────────────────────────────────────────────────────────────

    @Test
    fun `the Kin tab reverses between A to Z and Z to A`() {
        val rows = listOf(kin("k1", "Gravy"), kin("k2", "biscuit"), kin("k3", "Nacho"))
        assertEquals(listOf("biscuit", "Gravy", "Nacho"), filterKinDirectory(rows, "", TAG_FILTER_ALL, SortOption.AlphaAsc).map { it.name })
        assertEquals(listOf("Nacho", "Gravy", "biscuit"), filterKinDirectory(rows, "", TAG_FILTER_ALL, SortOption.AlphaDesc).map { it.name })
    }

    @Test
    fun `the Kin tab orders Recently Updated by updatedAt, newest first`() {
        val rows = listOf(
            kin("k1", "Gravy", updatedAt = "2026-07-01T00:00:00Z"),
            kin("k2", "Biscuit", updatedAt = "2026-09-01T00:00:00Z"),
            kin("k3", "Nacho"),
        )
        assertEquals(listOf("Biscuit", "Gravy", "Nacho"), filterKinDirectory(rows, "", TAG_FILTER_ALL, SortOption.RecentlyUpdated).map { it.name })
    }

    /** The flat `kin` collection has no createdAt, so the tab does not offer that sort. */
    @Test
    fun `the Kin tab offers only the sorts with a field behind them`() {
        assertEquals(listOf(SortOption.AlphaAsc, SortOption.AlphaDesc, SortOption.RecentlyUpdated), KIN_SORT_OPTIONS)
    }

    // ── Through the view model ──────────────────────────────────────────────

    private fun viewModelOver(kinfolk: List<Kinfolk>): DirectoryViewModel {
        val repository = mockk<AuntieRepository>(relaxed = true)
        val invoiceRepository = mockk<InvoiceRepository>(relaxed = true)
        val kinCareRepository = mockk<KinCareRepository>(relaxed = true)
        coEvery { repository.getKinfolk() } returns Result.success(kinfolk)
        coEvery { repository.getAllKin() } returns Result.success(emptyList())
        coEvery { kinCareRepository.getKinCareSessions() } returns Result.success(emptyList())
        return DirectoryViewModel(repository, invoiceRepository, kinCareRepository)
    }

    @Test
    fun `setSortOption reorders the displayed households and survives a search`() = runTest(testDispatcher) {
        val vm = viewModelOver(
            listOf(
                household("1", "Amy", "Adams"),
                household("2", "Zed", "Young"),
                household("3", "Bea", "Brook"),
            ),
        )
        advanceUntilIdle()
        assertEquals(listOf("1", "3", "2"), vm.directoryState.value.displayedKinfolk.map { it.id })

        vm.setSortOption(SortOption.AlphaDesc)
        advanceUntilIdle()
        assertEquals(SortOption.AlphaDesc, vm.directoryState.value.sortOption)
        assertEquals(listOf("2", "3", "1"), vm.directoryState.value.displayedKinfolk.map { it.id })

        vm.search("a")
        advanceUntilIdle()
        assertEquals(listOf("3", "1"), vm.directoryState.value.displayedKinfolk.map { it.id })
    }

    // ── The corner badge ────────────────────────────────────────────────────

    /** Five of the mock's six cards are active and wear nothing; the sixth wears "New". */
    @Test
    fun `an active household wears no badge`() {
        assertNull(cardBadge("active", isNew = false))
        assertNull(cardBadge("  Active ", isNew = false))
        assertNull(cardBadge("", isNew = false))
    }

    @Test
    fun `a new household wears New in the mock's orange, whatever its status`() {
        assertEquals("New" to AuntieStatusTone.Orange, cardBadge("active", isNew = true))
        assertEquals("New" to AuntieStatusTone.Orange, cardBadge("prospect", isNew = true))
    }

    @Test
    fun `any other status wears its own word and tone`() {
        assertEquals("prospect" to AuntieStatusTone.Teal, cardBadge("Prospect", isNew = false))
        assertEquals("inactive" to AuntieStatusTone.Muted, cardBadge("inactive", isNew = false))
        assertEquals("archived" to AuntieStatusTone.Warning, cardBadge("archived", isNew = false))
        assertEquals("paused" to AuntieStatusTone.Neutral, cardBadge("paused", isNew = false))
    }

    // ── The tab pill ────────────────────────────────────────────────────────

    /** The count is the mock's `.ct`, shown only once it is known; never a fabricated 0. */
    @Test
    fun `the tab label carries its count only once the roster has landed`() {
        assertEquals("Kinfolk", tabLabel("Kinfolk", null))
        assertEquals("Kinfolk · 8", tabLabel("Kinfolk", 8))
        assertEquals("Kin · 0", tabLabel("Kin", 0))
    }
}
