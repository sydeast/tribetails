package com.tribetails.auntieos.web.screens

import com.tribetails.auntieos.web.FakeAuntieDataSource
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.screens.directory.DirectoryUiState
import com.tribetails.auntieos.web.screens.directory.DirectoryViewModel
import com.tribetails.auntieos.web.util.SortOption
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DirectoryViewModelTest {

    // NOTE: redesign renamed DirectoryUiState.filtered -> filteredSorted (search + sort).
    private fun kinfolk(
        id: String,
        first: String,
        last: String = "",
        phone: String = "",
        email: String = "",
        status: String = "active",
    ) = Kinfolk(_id = id, firstName = first, lastName = last, phoneNumber = phone, email = email, status = status)

    // ── Loading state ─────────────────────────────────────────────────────────

    @Test
    fun initial_state_is_loading() = runTest(UnconfinedTestDispatcher()) {
        val ds = FakeAuntieDataSource()
        val vm = DirectoryViewModel(ds, scope = backgroundScope)
        assertTrue(vm.state.value.isLoading)
    }

    // ── Happy path ────────────────────────────────────────────────────────────

    @Test
    fun emitting_kinfolk_shows_all_when_query_blank() = runTest(UnconfinedTestDispatcher()) {
        val ds = FakeAuntieDataSource()
        val vm = DirectoryViewModel(ds, scope = backgroundScope)
        ds.emitKinfolk(FirestoreResult.Data(listOf(
            kinfolk("k1", "Priya", "Harris"),
            kinfolk("k2", "Devon", "Kim"),
        )))
        assertEquals(2, vm.state.value.filteredSorted.size)
    }

    @Test
    fun search_by_first_name_case_insensitive() = runTest(UnconfinedTestDispatcher()) {
        val ds = FakeAuntieDataSource()
        val vm = DirectoryViewModel(ds, scope = backgroundScope)
        ds.emitKinfolk(FirestoreResult.Data(listOf(
            kinfolk("k1", "Priya", "Harris"),
            kinfolk("k2", "Devon", "Kim"),
        )))
        vm.search("priy")
        val filtered = vm.state.value.filteredSorted
        assertEquals(1, filtered.size)
        assertEquals("k1", filtered.first()._id)
    }

    @Test
    fun search_by_last_name() = runTest(UnconfinedTestDispatcher()) {
        val ds = FakeAuntieDataSource()
        val vm = DirectoryViewModel(ds, scope = backgroundScope)
        ds.emitKinfolk(FirestoreResult.Data(listOf(
            kinfolk("k1", "Priya", "Harris"),
            kinfolk("k2", "Devon", "Kim"),
        )))
        vm.search("Kim")
        assertEquals(1, vm.state.value.filteredSorted.size)
        assertEquals("k2", vm.state.value.filteredSorted.first()._id)
    }

    @Test
    fun search_by_phone_number() = runTest(UnconfinedTestDispatcher()) {
        val ds = FakeAuntieDataSource()
        val vm = DirectoryViewModel(ds, scope = backgroundScope)
        ds.emitKinfolk(FirestoreResult.Data(listOf(
            kinfolk("k1", "Priya", phone = "5551234567"),
            kinfolk("k2", "Devon",   phone = "5559876543"),
        )))
        vm.search("5551234567")
        assertEquals(1, vm.state.value.filteredSorted.size)
        assertEquals("k1", vm.state.value.filteredSorted.first()._id)
    }

    @Test
    fun search_by_email_case_insensitive() = runTest(UnconfinedTestDispatcher()) {
        val ds = FakeAuntieDataSource()
        val vm = DirectoryViewModel(ds, scope = backgroundScope)
        ds.emitKinfolk(FirestoreResult.Data(listOf(
            kinfolk("k1", "Priya", email = "Priya@example.com"),
            kinfolk("k2", "Devon",   email = "devon@other.com"),
        )))
        vm.search("PRIYA@EXAMPLE")
        assertEquals(1, vm.state.value.filteredSorted.size)
        assertEquals("k1", vm.state.value.filteredSorted.first()._id)
    }

    // ── Clear / reset ─────────────────────────────────────────────────────────

    @Test
    fun clearSearch_restores_full_list() = runTest(UnconfinedTestDispatcher()) {
        val ds = FakeAuntieDataSource()
        val vm = DirectoryViewModel(ds, scope = backgroundScope)
        ds.emitKinfolk(FirestoreResult.Data(listOf(
            kinfolk("k1", "Priya"),
            kinfolk("k2", "Devon"),
        )))
        vm.search("Priya")
        assertEquals(1, vm.state.value.filteredSorted.size)
        vm.clearSearch()
        assertEquals(2, vm.state.value.filteredSorted.size)
    }

    // ── Sad path ──────────────────────────────────────────────────────────────

    @Test
    fun search_no_match_returns_empty_list() = runTest(UnconfinedTestDispatcher()) {
        val ds = FakeAuntieDataSource()
        val vm = DirectoryViewModel(ds, scope = backgroundScope)
        ds.emitKinfolk(FirestoreResult.Data(listOf(kinfolk("k1", "Priya"))))
        vm.search("zzz_no_match")
        assertTrue(vm.state.value.filteredSorted.isEmpty())
    }

    @Test
    fun search_while_loading_returns_empty_list() = runTest(UnconfinedTestDispatcher()) {
        val ds = FakeAuntieDataSource()
        val vm = DirectoryViewModel(ds, scope = backgroundScope)
        vm.search("anything")
        assertTrue(vm.state.value.filteredSorted.isEmpty())
    }

    // ── Error state ───────────────────────────────────────────────────────────

    @Test
    fun firestore_error_exposes_error_message() = runTest(UnconfinedTestDispatcher()) {
        val ds = FakeAuntieDataSource()
        val vm = DirectoryViewModel(ds, scope = backgroundScope)
        ds.emitKinfolk(FirestoreResult.Error("permission-denied"))
        assertEquals("permission-denied", vm.state.value.error)
        assertTrue(vm.state.value.filteredSorted.isEmpty())
    }

    @Test
    fun error_state_clears_when_data_arrives() = runTest(UnconfinedTestDispatcher()) {
        val ds = FakeAuntieDataSource()
        val vm = DirectoryViewModel(ds, scope = backgroundScope)
        ds.emitKinfolk(FirestoreResult.Error("transient"))
        ds.emitKinfolk(FirestoreResult.Data(listOf(kinfolk("k1", "Priya"))))
        assertNull(vm.state.value.error)
        assertEquals(1, vm.state.value.filteredSorted.size)
    }

    // ── Edge cases ────────────────────────────────────────────────────────────

    @Test
    fun search_whitespace_only_shows_all() = runTest(UnconfinedTestDispatcher()) {
        val ds = FakeAuntieDataSource()
        val vm = DirectoryViewModel(ds, scope = backgroundScope)
        ds.emitKinfolk(FirestoreResult.Data(listOf(kinfolk("k1", "Priya"), kinfolk("k2", "Devon"))))
        vm.search("   ")
        assertEquals(2, vm.state.value.filteredSorted.size)
    }

    @Test
    fun kinfolk_with_blank_name_uses_Unnamed_fallback_in_displayName() = runTest(UnconfinedTestDispatcher()) {
        val kf = Kinfolk(_id = "k0", firstName = "", lastName = "")
        assertEquals("Unnamed Kinfolk", kf.displayName)
    }

    @Test
    fun kinfolk_with_only_first_name_no_trailing_space() = runTest(UnconfinedTestDispatcher()) {
        val kf = Kinfolk(_id = "k1", firstName = "Priya", lastName = "")
        assertEquals("Priya", kf.displayName)
    }

    @Test
    fun search_partial_phone_matches() = runTest(UnconfinedTestDispatcher()) {
        val ds = FakeAuntieDataSource()
        val vm = DirectoryViewModel(ds, scope = backgroundScope)
        ds.emitKinfolk(FirestoreResult.Data(listOf(kinfolk("k1", "X", phone = "555-123-4567"))))
        vm.search("123")
        assertEquals(1, vm.state.value.filteredSorted.size)
    }

    // ── #1952: phone search only for phone-shaped text ───────────────────────

    private fun ids(query: String, rows: List<Kinfolk>): List<String> =
        DirectoryUiState(allKinfolk = FirestoreResult.Data(rows), query = query).filteredSorted.map { it._id }

    private val tess = kinfolk("t", "Tess", "Quill", phone = "(805) 555-0188", email = "catch@hanasamku.com")

    @Test
    fun text_with_a_digit_never_matches_on_the_phone() {
        assertEquals(emptyList(), ids("zzzz8", listOf(tess)))
        assertEquals(emptyList(), ids("Tes1", listOf(tess)))
        assertEquals(emptyList(), ids("8", listOf(tess)))
        assertEquals(emptyList(), ids("88", listOf(tess)))
        assertEquals(listOf("r"), ids("e2e", listOf(tess, kinfolk("r", "Rue", email = "e2e-admin@tribetails.com"))))
    }

    @Test
    fun a_full_number_in_any_common_format_matches_the_phone() {
        for (q in listOf("805", "0188", "805-555-0188", "(805) 555-0188", "805.555.0188", "+1 805 555 0188")) {
            assertEquals(listOf("t"), ids(q, listOf(tess)), q)
        }
        assertEquals(listOf("p"), ids("805 555 0188", listOf(kinfolk("p", "P", phone = "+18055550188"))))
        assertEquals(emptyList(), ids("555-0199", listOf(tess)))
    }

    // ── #1953: Recently Created ───────────────────────────────────────────────

    private fun sorted(rows: List<Kinfolk>): List<String> =
        DirectoryUiState(allKinfolk = FirestoreResult.Data(rows), sort = SortOption.RecentlyCreated).filteredSorted.map { it._id }

    @Test
    fun recently_created_puts_households_made_minutes_ago_first_though_their_join_date_is_blank() {
        val rows = listOf(
            kinfolk("old", "Amy", "Adams").copy(joinDate = "2026-06-01"),
            kinfolk("first", "Bea", "Brook").copy(createdAt = "2026-11-10T15:00:00Z"),
            kinfolk("none", "Cal", "Cole"),
            kinfolk("second", "Dee", "Dale").copy(createdAt = "2026-11-10T15:04:00Z"),
        )
        assertEquals(listOf("second", "first", "old", "none"), sorted(rows))
    }

    @Test
    fun recently_created_never_orders_by_an_import_date_and_compares_instants() {
        val rows = listOf(
            kinfolk("imported", "Amy", "Adams").copy(createdAt = "2026-11-11T00:00:00Z", createdAtSource = "import", joinDate = "2025-02-01"),
            kinfolk("live", "Bea", "Brook").copy(createdAt = "2026-09-01T00:00:00Z", createdAtSource = "live"),
            kinfolk("no-ms", "Cal", "Cole").copy(createdAt = "2026-09-01T00:00:01Z"),
            kinfolk("ms", "Dee", "Dale").copy(createdAt = "2026-09-01T00:00:00.900Z"),
        )
        assertEquals(listOf("no-ms", "ms", "live", "imported"), sorted(rows))
    }

    @Test
    fun recently_created_puts_records_with_no_readable_date_last_a_to_z() {
        val rows = listOf(
            kinfolk("z", "Zed", "Young"),
            kinfolk("junk", "Ann", "Adams").copy(joinDate = "07/24/2026", createdAt = "sometime"),
            kinfolk("dated", "Mo", "Mills").copy(joinDate = "2025-05-05"),
        )
        assertEquals(listOf("dated", "junk", "z"), sorted(rows))
    }

    /** #2171: a join date sits on the same timeline as a creation stamp, not below every stamped one. */
    @Test
    fun recently_created_puts_a_join_date_on_the_same_timeline_as_a_creation_stamp() {
        val rows = listOf(
            kinfolk("joined-today", "Amy", "Adams").copy(joinDate = "2026-11-12"),
            kinfolk("stamped", "Bea", "Brook").copy(createdAt = "2026-10-01T12:00:00Z"),
            kinfolk("joined-2025", "Cal", "Cole").copy(joinDate = "2025-03-04T10:00:00.000Z"),
        )
        assertEquals(listOf("joined-today", "stamped", "joined-2025"), sorted(rows))
    }

    /** #2171: a migrated household sorts by the old system's creation date, never its migration date. */
    @Test
    fun recently_created_places_a_migrated_household_below_a_newer_one_and_above_an_older_one() {
        val rows = listOf(
            kinfolk("older", "Amy", "Adams").copy(createdAt = "2021-08-15T10:30:00Z", createdAtSource = "original"),
            kinfolk("migrated", "Bea", "Brook").copy(createdAt = "2024-03-02T09:00:00.000Z", createdAtSource = "original", joinDate = "2025-06-01"),
            kinfolk("auntieos", "Cal", "Cole").copy(createdAt = "2026-11-10T15:04:00Z", createdAtSource = "live"),
            kinfolk("joined-older", "Dee", "Dale").copy(joinDate = "2022-04-01"),
        )
        assertEquals(listOf("auntieos", "migrated", "joined-older", "older"), sorted(rows))
    }

    // ── #2171 / #2155: the shared date-sort fixture ───────────────────────────
    // Same ids, instants and expected orders as admin web `directory.test.ts` and
    // Android `DirectorySortTest`, so the three clients are held to one order.

    private val sharedFixture: List<Kinfolk> = listOf(
        kinfolk("auntie-new", "Bea", "Brook").copy(createdAt = "2026-11-10T15:04:00Z", createdAtSource = "live"),
        kinfolk("migrated-mid", "Cal", "Cole").copy(
            createdAt = "2024-03-02T09:00:00.000Z", createdAtSource = "original", joinDate = "2025-06-01", updatedAt = "2026-11-12T08:00:00Z",
        ),
        kinfolk("migrated-old", "Eve", "Earl").copy(createdAt = "2021-08-15T10:30:00Z", createdAtSource = "original", updatedAt = "2026-11-11T20:00:00Z"),
        kinfolk("joined-only", "Amy", "Adams").copy(joinDate = "2022-04-01", updatedAt = "2026-11-11T20:00:00.500Z"),
        kinfolk("imported-unknown", "Fay", "Ford").copy(createdAt = "2026-11-11T00:00:00Z", createdAtSource = "import", joinDate = "2020-02-02"),
        kinfolk("tie-grant", "Gus", "Grant").copy(createdAt = "2026-09-01T00:00:00.000Z"),
        kinfolk("tie-hill", "Hal", "Hill").copy(createdAt = "2026-09-01T00:00:00Z"),
        kinfolk("no-date", "Zed", "Young"),
        kinfolk("no-date-junk", "Ann", "Abbot").copy(joinDate = "07/24/2026", createdAt = "sometime", updatedAt = "yesterday"),
    )

    private fun sharedOrder(sort: SortOption): List<String> =
        DirectoryUiState(allKinfolk = FirestoreResult.Data(sharedFixture), sort = sort).filteredSorted.map { it._id }

    @Test
    fun shared_fixture_recently_created_is_one_timeline_undated_last_a_to_z() {
        assertEquals(
            listOf(
                "auntie-new", "tie-grant", "tie-hill", "migrated-mid", "joined-only", "migrated-old", "imported-unknown",
                "no-date-junk", "no-date",
            ),
            sharedOrder(SortOption.RecentlyCreated),
        )
    }

    /** #2155: this sort read `joinDate`, so an edit never moved a household. */
    @Test
    fun shared_fixture_recently_updated_follows_the_last_change_and_falls_back_to_the_creation_date() {
        assertEquals(
            listOf(
                "migrated-mid", "joined-only", "migrated-old", "auntie-new", "tie-grant", "tie-hill", "imported-unknown",
                "no-date-junk", "no-date",
            ),
            sharedOrder(SortOption.RecentlyUpdated),
        )
    }

    /**
     * #2155: the stamp a desktop edit actually writes must read back as an
     * instant, or the edited household sorts as never changed. (The desktop's
     * `nowIso()` is zone-less and would not.)
     */
    @OptIn(kotlin.time.ExperimentalTime::class)
    @Test
    fun the_desktop_edit_stamp_reads_back_as_the_last_change() {
        val stamp = com.tribetails.auntieos.web.data.kinfolkUpdatedAtNow()
        val at = com.tribetails.auntieos.web.screens.directory.kinfolkUpdatedMillis(Kinfolk(_id = "k", updatedAt = stamp))
        assertTrue(at != null, "stamp $stamp did not read as an instant")
        val now = kotlin.time.Clock.System.now().toEpochMilliseconds()
        assertTrue(now - at in 0..60_000, "stamp $stamp is not now")
        val edited = kinfolk("edited", "Zed", "Young").copy(createdAt = "2020-01-01T00:00:00Z", updatedAt = stamp)
        val newer = kinfolk("created-today", "Amy", "Adams").copy(createdAt = "2026-11-01T00:00:00Z")
        assertEquals(
            listOf("edited", "created-today"),
            DirectoryUiState(allKinfolk = FirestoreResult.Data(listOf(newer, edited)), sort = SortOption.RecentlyUpdated).filteredSorted.map { it._id },
        )
    }

    /** The REST decoder hands a Timestamp over as `{seconds,nanoseconds}` or an ISO string; both read. */
    @Test
    fun createdAt_decodes_from_a_timestamp_object() {
        val json = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
        val kf = json.decodeFromString(Kinfolk.serializer(), """{"_id":"k","createdAt":{"seconds":1762786800,"nanoseconds":0},"createdAtSource":"live"}""")
        assertEquals("2025-11-10T15:00:00Z", kf.createdAt)
        assertEquals("live", kf.createdAtSource)
    }
}
