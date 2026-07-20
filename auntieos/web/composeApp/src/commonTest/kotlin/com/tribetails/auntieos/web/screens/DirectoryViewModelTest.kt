package com.tribetails.auntieos.web.screens

import com.tribetails.auntieos.web.FakeAuntieDataSource
import com.tribetails.auntieos.web.data.FirestoreResult
import com.tribetails.auntieos.web.data.Kinfolk
import com.tribetails.auntieos.web.screens.directory.DirectoryViewModel
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
}
