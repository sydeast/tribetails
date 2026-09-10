package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #713 second half: "tags are just labels and not actual tags which act like a
 * filter." Both directory tabs narrow by tag now, client-side over the roster
 * the screen already holds. These are the pure halves of that, and they mirror
 * `tagFilterOptions` / `matchesTag` / `filterSortKin` in the React admin
 * (auntieos-admin src/api/directory.ts) so the two surfaces narrow identically.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DirectoryTagFilterTest {

    private val testDispatcher = UnconfinedTestDispatcher()

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun kin(id: String, name: String, tags: List<String> = emptyList(), breed: String = "Corgi") =
        Kin(id = id, name = name, species = "Dog", breed = breed, tags = tags)

    // ── Option list ─────────────────────────────────────────────────────────

    @Test
    fun `offers every distinct tag alphabetically`() {
        val options = directoryTagOptions(
            listOf(listOf("Slow pay", "VIP"), listOf("Allergy"), emptyList()),
        )
        assertEquals(listOf("Allergy", "Slow pay", "VIP"), options)
    }

    /** "vip" and "VIP" are one tag everywhere else, so they must be one option here. */
    @Test
    fun `collapses casing and spacing to one option, keeping the first casing seen`() {
        assertEquals(listOf("VIP"), directoryTagOptions(listOf(listOf("VIP"), listOf("  vip "))))
    }

    @Test
    fun `offers nothing when no row carries a tag, so the control can hide itself`() {
        assertEquals(emptyList<String>(), directoryTagOptions(listOf(emptyList(), emptyList())))
        assertEquals(emptyList<String>(), directoryTagOptions(emptyList()))
    }

    /** A blank name is not a legal tag, and must never become a pickable option. */
    @Test
    fun `ignores blank names`() {
        assertEquals(listOf("VIP"), directoryTagOptions(listOf(listOf("", "   ", "VIP"))))
    }

    // ── Matching ────────────────────────────────────────────────────────────

    @Test
    fun `matches case- and whitespace-insensitively`() {
        assertTrue(matchesDirectoryTag(listOf("  vip "), "VIP"))
        assertFalse(matchesDirectoryTag(listOf("VIP"), "Slow pay"))
        assertFalse(matchesDirectoryTag(emptyList(), "VIP"))
    }

    @Test
    fun `a blank filter narrows nothing`() {
        assertTrue(matchesDirectoryTag(emptyList(), TAG_FILTER_ALL))
        assertTrue(matchesDirectoryTag(listOf("VIP"), "   "))
    }

    // ── The Kin tab's list ──────────────────────────────────────────────────

    @Test
    fun `narrows the Kin list to the chosen tag`() {
        val rows = listOf(
            kin("k1", "Biscuit", listOf("Reactive")),
            kin("k2", "Gravy", listOf("On meds")),
            kin("k3", "Nacho"),
        )
        assertEquals(listOf("Biscuit"), filterKinDirectory(rows, "", "Reactive").map { it.name })
    }

    @Test
    fun `the tag narrows on top of the search, and the sort survives both`() {
        val rows = listOf(
            kin("k1", "Zeke", listOf("Reactive")),
            kin("k2", "Ann", listOf("Reactive")),
            kin("k3", "Abe", listOf("On meds")),
        )
        assertEquals(listOf("Ann", "Zeke"), filterKinDirectory(rows, "", "Reactive").map { it.name })
        assertEquals(listOf("Ann"), filterKinDirectory(rows, "ann", "Reactive").map { it.name })
        assertEquals(emptyList<String>(), filterKinDirectory(rows, "Abe", "Reactive").map { it.name })
    }

    @Test
    fun `no tag filter leaves the existing search behavior untouched`() {
        val rows = listOf(
            kin("k1", "Biscuit", listOf("Reactive")),
            kin("k2", "Gravy", breed = "Beagle"),
        )
        assertEquals(2, filterKinDirectory(rows, "", TAG_FILTER_ALL).size)
        assertEquals(listOf("Gravy"), filterKinDirectory(rows, "beagle", TAG_FILTER_ALL).map { it.name })
    }

    // ── The Kinfolk tab, through the view model ─────────────────────────────

    private fun viewModelOver(kinfolk: List<Kinfolk>): DirectoryViewModel {
        val repository = mockk<AuntieRepository>(relaxed = true)
        val invoiceRepository = mockk<InvoiceRepository>(relaxed = true)
        val kinCareRepository = mockk<KinCareRepository>(relaxed = true)
        coEvery { repository.getKinfolk() } returns Result.success(kinfolk)
        coEvery { repository.getAllKin() } returns Result.success(emptyList())
        coEvery { kinCareRepository.getKinCareSessions() } returns Result.success(emptyList())
        return DirectoryViewModel(repository, invoiceRepository, kinCareRepository)
    }

    private fun household(id: String, first: String, tags: List<String> = emptyList()) =
        Kinfolk(id = id, firstName = first, lastName = "Doe", status = "active", tags = tags)

    @Test
    fun `setTagFilter narrows the household list`() = runTest(testDispatcher) {
        val vm = viewModelOver(
            listOf(
                household("1", "John", listOf("VIP")),
                household("2", "Jane", listOf("Slow pay")),
                household("3", "Ros"),
            ),
        )
        advanceUntilIdle()
        assertEquals(3, vm.directoryState.value.displayedKinfolk.size)

        vm.setTagFilter("VIP")
        advanceUntilIdle()

        assertEquals(listOf("1"), vm.directoryState.value.displayedKinfolk.map { it.id })
    }

    /** The tag sits BESIDE status and search, so all three narrow the one list. */
    @Test
    fun `the tag filter stacks with the status filter and the search`() = runTest(testDispatcher) {
        val vm = viewModelOver(
            listOf(
                household("1", "John", listOf("VIP")),
                Kinfolk(id = "2", firstName = "Jane", lastName = "Doe", status = "inactive", tags = listOf("VIP")),
            ),
        )
        advanceUntilIdle()

        vm.setTagFilter("VIP")
        advanceUntilIdle()
        // Status is still "Active" by default, so the inactive VIP stays hidden.
        assertEquals(listOf("1"), vm.directoryState.value.displayedKinfolk.map { it.id })

        vm.search("Jane")
        advanceUntilIdle()
        assertTrue(vm.directoryState.value.displayedKinfolk.isEmpty())
    }

    /**
     * The sequence this change makes reachable: filter by a tag, delete that tag
     * in Settings, pull to refresh. No row carries it any more, so the dropdown
     * hides itself; a filter left standing would strand the list on an empty
     * result with no control left to clear it.
     */
    @Test
    fun `a reload drops a tag filter no loaded household can satisfy`() = runTest(testDispatcher) {
        val repository = mockk<AuntieRepository>(relaxed = true)
        val invoiceRepository = mockk<InvoiceRepository>(relaxed = true)
        val kinCareRepository = mockk<KinCareRepository>(relaxed = true)
        coEvery { repository.getAllKin() } returns Result.success(emptyList())
        coEvery { kinCareRepository.getKinCareSessions() } returns Result.success(emptyList())
        coEvery { repository.getKinfolk() } returns Result.success(
            listOf(household("1", "John", listOf("VIP")), household("2", "Jane")),
        )
        val vm = DirectoryViewModel(repository, invoiceRepository, kinCareRepository)
        advanceUntilIdle()

        vm.setTagFilter("VIP")
        advanceUntilIdle()
        assertEquals(1, vm.directoryState.value.displayedKinfolk.size)

        // The cascade lands: nothing carries "VIP" any more.
        coEvery { repository.getKinfolk() } returns Result.success(
            listOf(household("1", "John"), household("2", "Jane")),
        )
        vm.loadDirectory()
        advanceUntilIdle()

        assertEquals(TAG_FILTER_ALL, vm.directoryState.value.tagFilter)
        assertEquals(2, vm.directoryState.value.displayedKinfolk.size)
    }

    @Test
    fun `clearing the tag filter puts every row back`() = runTest(testDispatcher) {
        val vm = viewModelOver(listOf(household("1", "John", listOf("VIP")), household("2", "Jane")))
        advanceUntilIdle()

        vm.setTagFilter("VIP")
        advanceUntilIdle()
        assertEquals(1, vm.directoryState.value.displayedKinfolk.size)

        vm.setTagFilter(TAG_FILTER_ALL)
        advanceUntilIdle()
        assertEquals(2, vm.directoryState.value.displayedKinfolk.size)
        assertFalse(vm.directoryState.value.displayedKinfolk.isEmpty())
    }
}
