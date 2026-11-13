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
            kinfolk("old", "Amy", "Adams").copy(joinDate = "2026-11-12"),
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

    /** The REST decoder hands a Timestamp over as `{seconds,nanoseconds}` or an ISO string; both read. */
    @Test
    fun createdAt_decodes_from_a_timestamp_object() {
        val json = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }
        val kf = json.decodeFromString(Kinfolk.serializer(), """{"_id":"k","createdAt":{"seconds":1762786800,"nanoseconds":0},"createdAtSource":"live"}""")
        assertEquals("2025-11-10T15:00:00Z", kf.createdAt)
        assertEquals("live", kf.createdAtSource)
    }
}
