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
        // The detail screen loads its payment lists from getInvoiceLedger now,
        // not from the raw root-collection read. A relaxed mockk cannot stand in:
        // Result<T> erases, so its default is a bare Object and the first read
        // throws. These cases are not about payments; an empty ledger is enough.
        coEvery { mockInvoiceRepo.getInvoiceLedger(any()) } returns Result.success(TestFixtures.emptyInvoiceLedger())
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
                linkedWithoutLine = listOf("ses2", "ses3"),
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
                linkedWithoutLine = listOf("ses1", "ses2"),
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

    // ── #1254: visits another invoice already bills ──────────────────────────

    @Test
    fun `linkPickerOnOtherInvoice marks only a visit claimed by a different invoice and not in the stored set`() {
        val stored = listOf("ses1")
        assertTrue(linkPickerOnOtherInvoice(session3.copy(invoiceId = "invA"), "inv1", stored))
        assertTrue(linkPickerOnOtherInvoice(session3.copy(invoiceId = "  invA "), "inv1", stored))
        // Unclaimed: empty and whitespace are one state.
        assertFalse(linkPickerOnOtherInvoice(session3.copy(invoiceId = ""), "inv1", stored))
        assertFalse(linkPickerOnOtherInvoice(session3.copy(invoiceId = "   "), "inv1", stored))
        // A back-link to THIS invoice is a half-link, not another invoice.
        assertFalse(linkPickerOnOtherInvoice(session3.copy(invoiceId = " inv1 "), "inv1", stored))
        // Already in the stored set: stays togglable whatever its back-link says.
        assertFalse(linkPickerOnOtherInvoice(session1.copy(invoiceId = "invA"), "inv1", stored))
    }

    @Test
    fun `toggleSessionInPending will not tick a visit on another invoice`() = runTest(testDispatcher) {
        val elsewhere = session3.copy(invoiceId = "invA")
        coEvery { mockInvoiceRepo.getInvoiceById("inv1") } returns Result.success(invoiceWithSessions)
        coEvery { mockKinCareRepo.getKinCareSessionsForKinfolk("kf1") } returns Result.success(
            listOf(session1, session2, elsewhere)
        )

        val vm = buildViewModel()
        vm.loadInvoice("inv1")
        advanceUntilIdle()
        vm.openEditMode()
        vm.toggleSessionInPending("ses3")

        assertEquals(setOf("ses1", "ses2"), vm.uiState.value.pendingSessionIds)
    }

    @Test
    fun `toggleSessionInPending still unticks a stored visit whose back-link names another invoice`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.getInvoiceById("inv1") } returns Result.success(invoiceWithSessions)
        coEvery { mockKinCareRepo.getKinCareSessionsForKinfolk("kf1") } returns Result.success(
            listOf(session1.copy(invoiceId = "invA"), session2)
        )

        val vm = buildViewModel()
        vm.loadInvoice("inv1")
        advanceUntilIdle()
        vm.openEditMode()
        vm.toggleSessionInPending("ses1")
        assertEquals(setOf("ses2"), vm.uiState.value.pendingSessionIds)
        vm.toggleSessionInPending("ses1")
        assertEquals(setOf("ses1", "ses2"), vm.uiState.value.pendingSessionIds)
    }

    @Test
    fun `saveLinks shows the server refusal verbatim inside the dialog and keeps it open`() = runTest(testDispatcher) {
        val refusal = "Already billed on another invoice: visit ses3 is on invoice INV-7. Unlink it there first."
        coEvery { mockInvoiceRepo.getInvoiceById("inv1") } returns Result.success(invoiceWithSessions)
        coEvery { mockKinCareRepo.getKinCareSessionsForKinfolk("kf1") } returns Result.success(
            listOf(session1, session2, session3)
        )
        coEvery { mockInvoiceRepo.linkInvoiceSessions("inv1", any()) } returns
            Result.failure(RuntimeException(refusal))

        val vm = buildViewModel()
        vm.loadInvoice("inv1")
        advanceUntilIdle()
        vm.openEditMode()
        vm.toggleSessionInPending("ses3")
        vm.saveLinks()
        advanceUntilIdle()

        val state = vm.uiState.value
        assertTrue(state.editMode)
        assertEquals(refusal, state.linkError)
        assertEquals(setOf("ses1", "ses2", "ses3"), state.pendingSessionIds)

        // A new pick clears it; reopening starts clean.
        vm.toggleSessionInPending("ses3")
        assertNull(vm.uiState.value.linkError)
        vm.saveLinks()
        advanceUntilIdle()
        assertEquals(refusal, vm.uiState.value.linkError)
        vm.closeEditMode()
        vm.openEditMode()
        assertNull(vm.uiState.value.linkError)
    }

    // ── #2091: linking says it adds no price; a billed line keeps its visit ──
    private val itemizedInvoice = invoiceWithSessions.copy(
        lineItems = listOf(
            mapOf("description" to "Dog Walking, May 1", "qty" to 1.0, "unitCents" to 4500L, "sessionId" to "ses1"),
            mapOf("description" to "Key cutting", "qty" to 1.0, "unitCents" to 900L),
        ),
    )
    @Test
    fun `linkPickerBilledIds reads the visits the lines are bound to`() {
        assertEquals(setOf("ses1"), linkPickerBilledIds(itemizedInvoice))
        // A typed-total invoice has no lines, so nothing is held.
        assertEquals(emptySet<String>(), linkPickerBilledIds(invoiceWithSessions))
    }
    @Test
    fun `a visit a line bills cannot be unticked, a linked visit with no line can`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.getInvoiceById("inv1") } returns Result.success(itemizedInvoice)
        coEvery { mockKinCareRepo.getKinCareSessionsForKinfolk("kf1") } returns Result.success(listOf(session1, session2))
        val vm = buildViewModel()
        vm.loadInvoice("inv1")
        advanceUntilIdle()
        vm.openEditMode()
        vm.toggleSessionInPending("ses1")
        assertEquals(setOf("ses1", "ses2"), vm.uiState.value.pendingSessionIds)
        vm.toggleSessionInPending("ses2")
        assertEquals(setOf("ses1"), vm.uiState.value.pendingSessionIds)
    }
    @Test
    fun `the saved toast says the linked visit's price was not added`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.getKinCareSessionsForKinfolk("kf1") } returns Result.success(
            listOf(session1, session2, session3)
        )
        coEvery { mockInvoiceRepo.linkInvoiceSessions("inv1", any()) } returns Result.success(
            LinkInvoiceSessionsResult(
                ok = true,
                invoiceId = "inv1",
                sessionIds = listOf("ses1", "ses2", "ses3"),
                added = listOf("ses3"),
                removed = emptyList(),
                linkedWithoutLine = listOf("ses2", "ses3"),
                status = "open",
                editScope = "all",
            )
        )
        coEvery { mockInvoiceRepo.getInvoiceById("inv1") } returns Result.success(itemizedInvoice)
        val vm = buildViewModel()
        vm.loadInvoice("inv1")
        advanceUntilIdle()
        vm.openEditMode()
        vm.toggleSessionInPending("ses3")
        vm.saveLinks()
        advanceUntilIdle()
        assertEquals(
            "Visits saved: 1 linked. The linked visit no longer shows as un-invoiced, and its price was not added to this invoice.",
            vm.uiState.value.toastMessage,
        )
        assertFalse(vm.uiState.value.toastIsError)
    }
    @Test
    fun `invoiceSessionLinksSavedText matches the web and desktop wording`() {
        fun r(added: List<String>, removed: List<String>, withoutLine: List<String>) = LinkInvoiceSessionsResult(
            ok = true, invoiceId = "inv1", sessionIds = emptyList(), added = added, removed = removed,
            linkedWithoutLine = withoutLine, status = "open", editScope = "all",
        )
        assertEquals("Linked visits unchanged.", invoiceSessionLinksSavedText(r(emptyList(), emptyList(), listOf("x"))))
        assertEquals("Visits saved: 1 linked.", invoiceSessionLinksSavedText(r(listOf("a"), emptyList(), emptyList())))
        assertEquals("Visits saved: 1 unlinked.", invoiceSessionLinksSavedText(r(emptyList(), listOf("b"), listOf("old"))))
        assertEquals(
            "Visits saved: 2 linked, 1 unlinked. The 2 linked visits no longer show as un-invoiced, and their prices were not added to this invoice.",
            invoiceSessionLinksSavedText(r(listOf("a", "c"), listOf("b"), listOf("a", "c"))),
        )
    }
    @Test
    fun `the chip says why a billed visit stays linked`() {
        val catalog = com.tribetails.auntieos.ui.admin.ServiceCatalog()
        val label = linkPickerChipLabel(session1, "2026-05-01", elsewhere = false, cancelled = false, catalog = catalog, billedHere = true)
        assertTrue(label.endsWith(" · billed on a line of this invoice, remove the line in Edit to unlink it"))
        // A locked invoice's lines cannot be removed in Edit, so Edit is not named.
        val locked = linkPickerChipLabel(session1, "2026-05-01", elsewhere = false, cancelled = false, catalog = catalog, billedHere = true, linesEditable = false)
        assertTrue(locked.endsWith(" · billed on a line of this invoice, and its lines are locked"))
        assertFalse(locked.contains("Edit"))
    }
}
