package com.tribetails.auntieos.ui.invoices

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.contracts.LinkInvoiceSessionsResult
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.VisitStatus
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

// Pure-helper tests: no Compose runtime needed; validates the ViewModel's
// decision logic for session-link edit mode and bidirectional save.

@OptIn(ExperimentalCoroutinesApi::class)
class InvoiceSessionLinkViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository
    private lateinit var mockInvoiceRepo: InvoiceRepository
    private lateinit var mockKinCareRepo: KinCareRepository

    private val invoiceWithSessions = Invoice(
        id         = "inv1",
        kinfolkId  = "kf1",
        kinfolkName = "Rosa Parks",
        total      = 120.0,
        amountDue  = 120.0,
        sessionIds = listOf("ses1", "ses2"),
        attribution = "greedy_by_date",
    )

    private val session1 = KinCareSession(
        id          = "ses1",
        kinfolkId   = "kf1",
        serviceType = "Dog Walking",
        status      = VisitStatus.COMPLETED.name,
        startTime   = "2026-05-01T10:00:00Z",
    )
    private val session2 = KinCareSession(
        id          = "ses2",
        kinfolkId   = "kf1",
        serviceType = "Dog Walking",
        status      = VisitStatus.COMPLETED.name,
        startTime   = "2026-05-08T10:00:00Z",
    )
    private val session3 = KinCareSession(
        id          = "ses3",
        kinfolkId   = "kf1",
        serviceType = "Dog Walking",
        status      = VisitStatus.COMPLETED.name,
        startTime   = "2026-05-15T10:00:00Z",
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk(relaxed = true)
        mockInvoiceRepo = mockk(relaxed = true)
        mockKinCareRepo = mockk(relaxed = true)
        // loadInvoice now also loads payments for the per-invoice join; stub it so
        // these session-link tests stay deterministic.
        coEvery { mockInvoiceRepo.getPayments() } returns Result.success(emptyList<com.tribetails.auntieos.data.model.Payment>())
        // A8: loadInvoice also fetches business settings for the "How to pay" section.
        // A relaxed mock can't fabricate Result<BusinessSettings> (value class), so stub it.
        coEvery { mockRepo.getBusinessSettings() } returns Result.success(com.tribetails.auntieos.data.model.BusinessSettings())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun buildViewModel() = InvoiceDetailViewModel(repository = mockRepo, invoiceRepository = mockInvoiceRepo, kinCareRepository = mockKinCareRepo)

    // ── Load + session fetch ──────────────────────────────────────────────────

    @Test
    fun `loadInvoice fetches sessions for kinfolk on success`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.getInvoiceById("inv1") } returns Result.success(invoiceWithSessions)
        coEvery { mockKinCareRepo.getKinCareSessionsForKinfolk("kf1") } returns Result.success(
            listOf(session1, session2, session3)
        )

        val vm = buildViewModel()
        vm.loadInvoice("inv1")
        advanceUntilIdle()

        val state = vm.uiState.value
        assertNotNull(state.invoice)
        assertEquals(3, state.availableSessions.size)
        assertFalse(state.sessionsLoading)
        coVerify(exactly = 1) { mockKinCareRepo.getKinCareSessionsForKinfolk("kf1") }
    }

    @Test
    fun `loadInvoice does not fetch sessions when kinfolkId is blank`() = runTest(testDispatcher) {
        val invoiceNoKinfolk = invoiceWithSessions.copy(kinfolkId = "")
        coEvery { mockInvoiceRepo.getInvoiceById("inv1") } returns Result.success(invoiceNoKinfolk)

        val vm = buildViewModel()
        vm.loadInvoice("inv1")
        advanceUntilIdle()

        val state = vm.uiState.value
        assertEquals(0, state.availableSessions.size)
        coVerify(exactly = 0) { mockKinCareRepo.getKinCareSessionsForKinfolk(any()) }
    }

    @Test
    fun `sessions load error shows toast without blocking invoice display`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.getInvoiceById("inv1") } returns Result.success(invoiceWithSessions)
        coEvery { mockKinCareRepo.getKinCareSessionsForKinfolk("kf1") } returns Result.failure(
            RuntimeException("Firestore timeout")
        )

        val vm = buildViewModel()
        vm.loadInvoice("inv1")
        advanceUntilIdle()

        val state = vm.uiState.value
        assertNotNull(state.invoice)               // invoice still loaded
        assertTrue(state.toastVisible)
        assertTrue(state.toastIsError)
        assertTrue(state.toastMessage.contains("Firestore timeout"))
    }

    // ── Edit-mode lifecycle ───────────────────────────────────────────────────

    @Test
    fun `openEditMode seeds pendingSessionIds from invoice sessionIds`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.getInvoiceById("inv1") } returns Result.success(invoiceWithSessions)
        coEvery { mockKinCareRepo.getKinCareSessionsForKinfolk("kf1") } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.loadInvoice("inv1")
        advanceUntilIdle()

        vm.openEditMode()

        val state = vm.uiState.value
        assertTrue(state.editMode)
        assertEquals(setOf("ses1", "ses2"), state.pendingSessionIds)
    }

    @Test
    fun `closeEditMode clears edit flag`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.getInvoiceById("inv1") } returns Result.success(invoiceWithSessions)
        coEvery { mockKinCareRepo.getKinCareSessionsForKinfolk("kf1") } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.loadInvoice("inv1")
        advanceUntilIdle()
        vm.openEditMode()
        vm.closeEditMode()

        assertFalse(vm.uiState.value.editMode)
    }

    @Test
    fun `toggleSessionInPending adds unselected session`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.getInvoiceById("inv1") } returns Result.success(invoiceWithSessions)
        coEvery { mockKinCareRepo.getKinCareSessionsForKinfolk("kf1") } returns Result.success(
            listOf(session1, session2, session3)
        )

        val vm = buildViewModel()
        vm.loadInvoice("inv1")
        advanceUntilIdle()
        vm.openEditMode()                        // pending = {ses1, ses2}
        vm.toggleSessionInPending("ses3")        // add ses3

        assertTrue("ses3" in vm.uiState.value.pendingSessionIds)
        assertEquals(3, vm.uiState.value.pendingSessionIds.size)
    }

    @Test
    fun `toggleSessionInPending removes already-selected session`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.getInvoiceById("inv1") } returns Result.success(invoiceWithSessions)
        coEvery { mockKinCareRepo.getKinCareSessionsForKinfolk("kf1") } returns Result.success(
            listOf(session1, session2)
        )

        val vm = buildViewModel()
        vm.loadInvoice("inv1")
        advanceUntilIdle()
        vm.openEditMode()                        // pending = {ses1, ses2}
        vm.toggleSessionInPending("ses1")        // remove ses1

        assertFalse("ses1" in vm.uiState.value.pendingSessionIds)
        assertEquals(1, vm.uiState.value.pendingSessionIds.size)
    }

    // ── saveLinks ─────────────────────────────────────────────────────────────
    // W2-2 of ADR-0002: ONE linkInvoiceSessions call carries the FULL new set;
    // the server derives added/removed inside its transaction and writes both
    // directions atomically. There are no per-session repository calls to
    // verify any more - that loop is the defect the callable removed.

    @Test
    fun `saveLinks calls linkInvoiceSessions with the full pending set`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.getInvoiceById("inv1") } returns Result.success(invoiceWithSessions)
        coEvery { mockKinCareRepo.getKinCareSessionsForKinfolk("kf1") } returns Result.success(
            listOf(session1, session2, session3)
        )
        val updatedInvoice = invoiceWithSessions.copy(sessionIds = listOf("ses2", "ses3"), attribution = "manual")
        coEvery { mockInvoiceRepo.linkInvoiceSessions("inv1", any()) } returns Result.success(
            LinkInvoiceSessionsResult(
                ok = true,
                invoiceId = "inv1",
                sessionIds = listOf("ses2", "ses3"),
                added = listOf("ses3"),
                removed = listOf("ses1"),
                status = "sent",
                editScope = "all",
            )
        )
        coEvery { mockInvoiceRepo.getInvoiceById("inv1") } returnsMany listOf(
            Result.success(invoiceWithSessions),
            Result.success(updatedInvoice),
        )

        val vm = buildViewModel()
        vm.loadInvoice("inv1")
        advanceUntilIdle()
        vm.openEditMode()
        vm.toggleSessionInPending("ses1")   // remove ses1
        vm.toggleSessionInPending("ses3")   // add ses3
        vm.saveLinks()
        advanceUntilIdle()

        // The FULL new set rides one call; the delta is the server's to derive.
        val sent = slot<List<String>>()
        coVerify(exactly = 1) { mockInvoiceRepo.linkInvoiceSessions("inv1", capture(sent)) }
        assertEquals(setOf("ses2", "ses3"), sent.captured.toSet())

        val state = vm.uiState.value
        assertFalse("Edit mode should be closed after save", state.editMode)
        assertTrue(state.toastVisible)
        assertFalse(state.toastIsError)
    }

    @Test
    fun `saveLinks shows error toast when linkInvoiceSessions fails`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.getInvoiceById("inv1") } returns Result.success(invoiceWithSessions)
        coEvery { mockKinCareRepo.getKinCareSessionsForKinfolk("kf1") } returns Result.success(emptyList())
        coEvery { mockInvoiceRepo.linkInvoiceSessions("inv1", any()) } returns
            Result.failure(RuntimeException("Permission denied"))

        val vm = buildViewModel()
        vm.loadInvoice("inv1")
        advanceUntilIdle()
        vm.openEditMode()
        vm.saveLinks()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertTrue("Should still be in edit mode after save failure", state.editMode)
        assertTrue(state.toastVisible)
        assertTrue(state.toastIsError)
        assertTrue(state.toastMessage.contains("Permission denied"))
    }

    @Test
    fun `dismissToast clears toast visibility`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.getInvoiceById("inv1") } returns Result.success(invoiceWithSessions)
        coEvery { mockKinCareRepo.getKinCareSessionsForKinfolk("kf1") } returns
            Result.failure(RuntimeException("boom"))

        val vm = buildViewModel()
        vm.loadInvoice("inv1")
        advanceUntilIdle()

        assertTrue(vm.uiState.value.toastVisible)
        vm.dismissToast()
        assertFalse(vm.uiState.value.toastVisible)
    }

    // ── saveLinks with no-op (nothing added or removed) ──────────────────────

    @Test
    fun `saveLinks with unchanged selection still sends the full set and closes edit mode`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.getInvoiceById("inv1") } returns Result.success(invoiceWithSessions)
        coEvery { mockKinCareRepo.getKinCareSessionsForKinfolk("kf1") } returns Result.success(
            listOf(session1, session2)
        )
        // Full-set semantics: the client always sends the whole set; a no-change
        // save comes back with an empty added/removed delta, derived server-side.
        coEvery { mockInvoiceRepo.linkInvoiceSessions("inv1", any()) } returns Result.success(
            LinkInvoiceSessionsResult(
                ok = true,
                invoiceId = "inv1",
                sessionIds = listOf("ses1", "ses2"),
                added = emptyList(),
                removed = emptyList(),
                status = "sent",
                editScope = "all",
            )
        )
        val refreshed = invoiceWithSessions.copy(attribution = "manual")
        coEvery { mockInvoiceRepo.getInvoiceById("inv1") } returnsMany listOf(
            Result.success(invoiceWithSessions),
            Result.success(refreshed),
        )

        val vm = buildViewModel()
        vm.loadInvoice("inv1")
        advanceUntilIdle()
        vm.openEditMode()   // pending = {ses1, ses2} - no changes
        vm.saveLinks()
        advanceUntilIdle()

        assertFalse(vm.uiState.value.editMode)
        val sent = slot<List<String>>()
        coVerify(exactly = 1) { mockInvoiceRepo.linkInvoiceSessions("inv1", capture(sent)) }
        assertEquals(setOf("ses1", "ses2"), sent.captured.toSet())
    }
}
