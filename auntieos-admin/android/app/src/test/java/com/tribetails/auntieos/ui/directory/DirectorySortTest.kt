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

    /** #1565: a household with no last name stays in the list and sorts by the name it has. */
    @Test
    fun `a household with no last name is kept and sorted by its first name`() {
        val rows = listOf(
            household("1", "Ann", "Young"),
            household("2", "No Lead", ""),
            household("3", "Zed", "Adams"),
        )
        val out = sortKinfolkDirectory(rows, SortOption.AlphaAsc)
        assertEquals(3, out.size)
        assertEquals(listOf("3", "2", "1"), out.map { it.id })
    }
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

    /** A household from before the `createdAt` stamp is placed by its join date. */
    @Test
    fun `Recently Created puts the newest join date first among households with no creation stamp`() {
        val rows = listOf(
            household("1", "Amy", "Adams", joinDate = "2026-01-05"),
            household("2", "Bea", "Brook", joinDate = "2026-03-01"),
            household("3", "Cal", "Cole", joinDate = "2025-12-30"),
        )
        assertEquals(listOf("2", "1", "3"), sortKinfolkDirectory(rows, SortOption.RecentlyCreated).map { it.id })
    }

    private fun ts(iso: String) = com.google.firebase.Timestamp(java.util.Date.from(java.time.Instant.parse(iso)))

    /**
     * #1953: Add Kinfolk writes `joinDate` blank, so two households made minutes
     * ago sorted near the bottom. `createdAt`, stamped by the createKinfolk
     * callable, is the creation date.
     */
    @Test
    fun `Recently Created puts households made minutes ago first, newest first, though their join date is blank`() {
        val rows = listOf(
            household("old", "Amy", "Adams", joinDate = "2026-06-01"),
            household("first", "Bea", "Brook").copy(createdAt = ts("2026-11-10T15:00:00Z")),
            household("none", "Cal", "Cole"),
            household("second", "Dee", "Dale").copy(createdAt = ts("2026-11-10T15:04:00Z")),
        )
        assertEquals(listOf("second", "first", "old", "none"), sortKinfolkDirectory(rows, SortOption.RecentlyCreated).map { it.id })
    }

    @Test
    fun `Recently Created never orders by an import date and compares instants, not text`() {
        val rows = listOf(
            household("imported", "Amy", "Adams", joinDate = "2025-02-01")
                .copy(createdAt = ts("2026-11-11T00:00:00Z"), createdAtSource = "import"),
            household("live", "Bea", "Brook").copy(createdAt = ts("2026-09-01T00:00:00Z"), createdAtSource = "live"),
            household("no-ms", "Cal", "Cole").copy(createdAt = "2026-09-01T00:00:01Z"),
            household("ms", "Dee", "Dale").copy(createdAt = "2026-09-01T00:00:00.900Z"),
        )
        assertEquals(listOf("no-ms", "ms", "live", "imported"), sortKinfolkDirectory(rows, SortOption.RecentlyCreated).map { it.id })
    }

    @Test
    fun `Recently Created puts records with no readable date last, A to Z among themselves`() {
        val rows = listOf(
            household("z", "Zed", "Young"),
            household("junk", "Ann", "Adams", joinDate = "07/24/2026").copy(createdAt = "sometime"),
            household("dated", "Mo", "Mills", joinDate = "2025-05-05"),
        )
        assertEquals(listOf("dated", "junk", "z"), sortKinfolkDirectory(rows, SortOption.RecentlyCreated).map { it.id })
    }

    /** #2171: a join date sits on the same timeline as a creation stamp, not below every stamped one. */
    @Test
    fun `Recently Created puts a join date on the same timeline as a creation stamp`() {
        val rows = listOf(
            household("joined-today", "Amy", "Adams", joinDate = "2026-11-12"),
            household("stamped", "Bea", "Brook").copy(createdAt = ts("2026-10-01T12:00:00Z")),
            household("joined-2025", "Cal", "Cole", joinDate = "2025-03-04T10:00:00.000Z"),
        )
        assertEquals(listOf("joined-today", "stamped", "joined-2025"), sortKinfolkDirectory(rows, SortOption.RecentlyCreated).map { it.id })
    }

    /** #2171: a migrated household sorts by the old system's creation date, never its migration date. */
    @Test
    fun `Recently Created places a migrated household below a newer one and above an older one`() {
        val rows = listOf(
            household("older", "Amy", "Adams").copy(createdAt = "2021-08-15T10:30:00Z", createdAtSource = "original"),
            household("migrated", "Bea", "Brook", joinDate = "2025-06-01")
                .copy(createdAt = "2024-03-02T09:00:00.000Z", createdAtSource = "original"),
            household("auntieos", "Cal", "Cole").copy(createdAt = ts("2026-11-10T15:04:00Z"), createdAtSource = "live"),
            household("joined-older", "Dee", "Dale", joinDate = "2022-04-01"),
        )
        assertEquals(listOf("auntieos", "migrated", "joined-older", "older"), sortKinfolkDirectory(rows, SortOption.RecentlyCreated).map { it.id })
    }

    /**
     * #2171 / #2155: the shared date-sort fixture. Same ids, instants and
     * expected orders as admin web `directory.test.ts` and desktop
     * `DirectoryViewModelTest`, so the three clients are held to one order.
     */
    private val sharedFixture: List<Kinfolk> = listOf(
        household("auntie-new", "Bea", "Brook").copy(createdAt = ts("2026-11-10T15:04:00Z"), createdAtSource = "live"),
        household("migrated-mid", "Cal", "Cole", joinDate = "2025-06-01", updatedAt = "2026-11-12T08:00:00Z")
            .copy(createdAt = "2024-03-02T09:00:00.000Z", createdAtSource = "original"),
        household("migrated-old", "Eve", "Earl", updatedAt = "2026-11-11T20:00:00Z")
            .copy(createdAt = "2021-08-15T10:30:00Z", createdAtSource = "original"),
        household("joined-only", "Amy", "Adams", joinDate = "2022-04-01").copy(updatedAt = ts("2026-11-11T20:00:00.500Z")),
        household("imported-unknown", "Fay", "Ford", joinDate = "2020-02-02")
            .copy(createdAt = ts("2026-11-11T00:00:00Z"), createdAtSource = "import"),
        household("tie-grant", "Gus", "Grant").copy(createdAt = "2026-09-01T00:00:00.000Z"),
        household("tie-hill", "Hal", "Hill").copy(createdAt = "2026-09-01T00:00:00Z"),
        household("no-date", "Zed", "Young"),
        household("no-date-junk", "Ann", "Abbot", joinDate = "07/24/2026", updatedAt = "yesterday").copy(createdAt = "sometime"),
    )

    @Test
    fun `shared fixture - Recently Created is one timeline, undated last A to Z`() {
        assertEquals(
            listOf(
                "auntie-new", "tie-grant", "tie-hill", "migrated-mid", "joined-only", "migrated-old", "imported-unknown",
                "no-date-junk", "no-date",
            ),
            sortKinfolkDirectory(sharedFixture, SortOption.RecentlyCreated).map { it.id },
        )
    }

    @Test
    fun `shared fixture - Recently Updated follows the last change and falls back to the creation date`() {
        assertEquals(
            listOf(
                "migrated-mid", "joined-only", "migrated-old", "auntie-new", "tie-grant", "tie-hill", "imported-unknown",
                "no-date-junk", "no-date",
            ),
            sortKinfolkDirectory(sharedFixture, SortOption.RecentlyUpdated).map { it.id },
        )
    }

    // ── Search (#1952) ──────────────────────────────────────────────────────

    private val tess = Kinfolk(id = "t", firstName = "Tess", lastName = "Quill", email = "catch@hanasamku.com", phoneNumber = "(805) 555-0188")

    /** #1952: text holding a digit used to list households by that digit alone (web, desktop). */
    @Test
    fun `text with letters and a digit never matches on the phone`() {
        assertEquals(false, matchesKinfolkSearch(tess, "zzzz8"))
        assertEquals(false, matchesKinfolkSearch(tess, "Tes1"))
        assertEquals(false, matchesKinfolkSearch(tess, "8"))
        assertEquals(false, matchesKinfolkSearch(tess, "88"))
        assertEquals(true, matchesKinfolkSearch(Kinfolk(email = "e2e-admin@tribetails.com"), "e2e"))
        assertEquals(true, matchesKinfolkSearch(tess, "quill"))
        assertEquals(true, matchesKinfolkSearch(tess, "  "))
    }

    /** Android compared the typed text with the stored phone as text, so bare digits never found "(805) 555-0188". */
    @Test
    fun `an area code, the last four or a full number in any common format matches the phone`() {
        for (q in listOf("805", "0188", "8055550188", "805-555-0188", "(805) 555-0188", "805.555.0188", "+1 805 555 0188")) {
            assertEquals(q, true, matchesKinfolkSearch(tess, q))
        }
        assertEquals(true, matchesKinfolkSearch(tess.copy(phoneNumber = "+18055550188"), "805 555 0188"))
        assertEquals(false, matchesKinfolkSearch(tess, "555-0199"))
        assertEquals(false, matchesKinfolkSearch(tess.copy(phoneNumber = ""), "0188"))
    }

    @Test
    fun `the view model search uses the phone rule`() = runTest(testDispatcher) {
        val vm = viewModelOver(
            listOf(
                tess.copy(id = "a"),
                Kinfolk(id = "b", firstName = "Amy", lastName = "Adams", phoneNumber = "805-555-0128"),
            ),
        )
        advanceUntilIdle()
        vm.search("zzzz8")
        advanceUntilIdle()
        assertEquals(emptyList<String>(), vm.directoryState.value.displayedKinfolk.map { it.id })
        vm.search("8055550188")
        advanceUntilIdle()
        assertEquals(listOf("a"), vm.directoryState.value.displayedKinfolk.map { it.id })
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
