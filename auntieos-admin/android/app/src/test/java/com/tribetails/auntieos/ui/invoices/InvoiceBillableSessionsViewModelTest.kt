package com.tribetails.auntieos.ui.invoices
import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResult
import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResultSession
import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResultUnplaceable
import com.tribetails.auntieos.data.contracts.ListUninvoicedSessionsResultUnpriceable
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.Invoice
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.model.Payment
import com.tribetails.auntieos.data.model.VisitStatus
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import io.mockk.coEvery
import io.mockk.coVerify
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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
/**
 * Edit mode used to offer EVERY session for the household, straight from
 * Firestore with no predicate: a visit already billed on another invoice and one
 * that has not happened yet rendered as ordinary candidates. That is how the
 * wrong session gets attached to a bill.
 *
 * `listUninvoicedSessions` is the server's answer to which visits are actually
 * billable, and these pin that the answer reaches the screen, including the two
 * things about it that are easy to drop: a visit the rate card could not price
 * is NOT priced at zero, and billable work no date window can reach is named
 * rather than omitted.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class InvoiceBillableSessionsViewModelTest {
    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository
    private lateinit var mockInvoiceRepo: InvoiceRepository
    private lateinit var mockKinCareRepo: KinCareRepository
    private val invoice = Invoice(
        id = "inv1",
        kinfolkId = "kf1",
        kinfolkName = "Rosa Parks",
        total = 120.0,
        amountDue = 120.0,
        sessionIds = listOf("ses1"),
    )
    private fun session(id: String) = KinCareSession(
        id = id,
        kinfolkId = "kf1",
        serviceType = "Dog Walking",
        status = VisitStatus.COMPLETED.name,
        startTime = "2026-05-01T10:00:00Z",
    )
    private fun billable(
        id: String,
        kinfolkId: String = "kf1",
        unitCents: Long? = 2500,
    ) = ListUninvoicedSessionsResultSession(
        sessionId = id,
        kinfolkId = kinfolkId,
        serviceType = "Dog Walking",
        durationMinutes = 30.0,
        startTime = "2026-05-01T10:00:00Z",
        unitCents = unitCents,
    )
    private fun result(
        sessions: List<ListUninvoicedSessionsResultSession> = emptyList(),
        unpriceable: List<ListUninvoicedSessionsResultUnpriceable> = emptyList(),
        unplaceable: List<ListUninvoicedSessionsResultUnplaceable> = emptyList(),
        rateCardLoaded: Boolean = true,
        truncated: Boolean = false,
    ) = ListUninvoicedSessionsResult(
        sessions = sessions,
        unpriceable = unpriceable,
        unplaceable = unplaceable,
        rateCardLoaded = rateCardLoaded,
        scanned = sessions.size.toLong(),
        truncated = truncated,
    )
    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk(relaxed = true)
        mockInvoiceRepo = mockk(relaxed = true)
        mockKinCareRepo = mockk(relaxed = true)
        coEvery { mockInvoiceRepo.getPayments() } returns Result.success(emptyList<Payment>())
        coEvery { mockRepo.getBusinessSettings() } returns Result.success(BusinessSettings())
        coEvery { mockInvoiceRepo.getInvoiceById("inv1") } returns Result.success(invoice)
        coEvery { mockKinCareRepo.getKinCareSessionsForKinfolk("kf1") } returns Result.success(
            listOf(session("ses1"), session("ses2"), session("ses3")),
        )
        coEvery { mockInvoiceRepo.listUninvoicedSessions(any(), any()) } returns Result.success(result())
    }
    @After
    fun tearDown() = Dispatchers.resetMain()
    private fun buildViewModel() = InvoiceDetailViewModel(
        repository = mockRepo,
        invoiceRepository = mockInvoiceRepo,
        kinCareRepository = mockKinCareRepo,
    )
    private fun openedEditMode(): InvoiceDetailViewModel {
        val vm = buildViewModel()
        vm.loadInvoice("inv1")
        vm.openEditMode()
        return vm
    }
    @Test
    fun `opening edit mode asks the server which visits are still billable`() = runTest(testDispatcher) {
        val vm = openedEditMode()
        advanceUntilIdle()
        coVerify(exactly = 1) { mockInvoiceRepo.listUninvoicedSessions(any(), any()) }
        assertFalse(vm.uiState.value.billableLoading)
    }
    @Test
    fun `the billable set marks candidates without hiding the unfiltered list`() = runTest(testDispatcher) {
        // ses1 is already ON this invoice, so the server excludes it as claimed.
        // It must stay in availableSessions or it could never be unlinked.
        coEvery { mockInvoiceRepo.listUninvoicedSessions(any(), any()) } returns Result.success(
            result(sessions = listOf(billable("ses2"))),
        )
        val vm = openedEditMode()
        advanceUntilIdle()
        val state = vm.uiState.value
        assertEquals(setOf("ses2"), state.billableSessionIds)
        assertEquals(3, state.availableSessions.size)
        assertTrue("the already-linked session stays selectable", "ses1" in state.pendingSessionIds)
    }
    @Test
    fun `another household's billable visits are not offered on this invoice`() = runTest(testDispatcher) {
        // The callable windows by DATE across the whole collection, not by
        // household, so the narrowing has to happen client-side.
        coEvery { mockInvoiceRepo.listUninvoicedSessions(any(), any()) } returns Result.success(
            result(sessions = listOf(billable("ses2"), billable("other", kinfolkId = "kf-someone-else"))),
        )
        val vm = openedEditMode()
        advanceUntilIdle()
        assertEquals(setOf("ses2"), vm.uiState.value.billableSessionIds)
    }
    @Test
    fun `a visit the rate card could not price is flagged, never treated as free`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.listUninvoicedSessions(any(), any()) } returns Result.success(
            result(
                sessions = listOf(billable("ses2", unitCents = null)),
                unpriceable = listOf(ListUninvoicedSessionsResultUnpriceable(sessionId = "ses2", serviceType = "Dog Walking")),
            ),
        )
        val vm = openedEditMode()
        advanceUntilIdle()
        assertEquals(setOf("ses2"), vm.uiState.value.unpricedSessionIds)
        assertTrue("it is still billable, just unpriced", "ses2" in vm.uiState.value.billableSessionIds)
    }
    @Test
    fun `no rate card at all is a different fact from a missing entry`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.listUninvoicedSessions(any(), any()) } returns Result.success(
            result(sessions = listOf(billable("ses2", unitCents = null)), rateCardLoaded = false),
        )
        val vm = openedEditMode()
        advanceUntilIdle()
        assertFalse(vm.uiState.value.rateCardLoaded)
    }
    @Test
    fun `work no date window can reach is named for this household only`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.listUninvoicedSessions(any(), any()) } returns Result.success(
            result(
                unplaceable = listOf(
                    ListUninvoicedSessionsResultUnplaceable(sessionId = "vis_lost", kinfolkId = "kf1"),
                    ListUninvoicedSessionsResultUnplaceable(sessionId = "vis_theirs", kinfolkId = "kf-other"),
                ),
            ),
        )
        val vm = openedEditMode()
        advanceUntilIdle()
        assertEquals(listOf("vis_lost"), vm.uiState.value.unplaceableSessionIds)
    }
    @Test
    fun `a truncated page is reported, so a short list is not read as complete`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.listUninvoicedSessions(any(), any()) } returns Result.success(
            result(sessions = listOf(billable("ses2")), truncated = true),
        )
        val vm = openedEditMode()
        advanceUntilIdle()
        assertTrue(vm.uiState.value.billableTruncated)
    }
    @Test
    fun `a failed billable check is recorded, never silently an empty set`() = runTest(testDispatcher) {
        // "Nothing is billable" and "we could not find out" are the same screen
        // otherwise, and the first invites the operator to attach nothing.
        coEvery { mockInvoiceRepo.listUninvoicedSessions(any(), any()) } returns
            Result.failure(RuntimeException("deadline-exceeded"))
        val vm = openedEditMode()
        advanceUntilIdle()
        val state = vm.uiState.value
        assertNotNull(state.billableError)
        assertTrue(state.billableError!!.contains("deadline-exceeded"))
        assertFalse(state.billableLoading)
        assertTrue(state.billableSessionIds.isEmpty())
        // The unfiltered list is untouched, so the operator can still work.
        assertEquals(3, state.availableSessions.size)
    }
    @Test
    fun `an invoice with no household does not spend a call`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.getInvoiceById("inv1") } returns Result.success(invoice.copy(kinfolkId = ""))
        val vm = buildViewModel()
        vm.loadInvoice("inv1")
        vm.openEditMode()
        advanceUntilIdle()
        coVerify(exactly = 0) { mockInvoiceRepo.listUninvoicedSessions(any(), any()) }
        assertNull(vm.uiState.value.billableError)
    }
}
