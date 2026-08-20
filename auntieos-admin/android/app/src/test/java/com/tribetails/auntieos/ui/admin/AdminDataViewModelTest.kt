package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.TestFixtures
import com.tribetails.auntieos.data.admin.ActivityLogEntry
import com.tribetails.auntieos.data.admin.NotificationEntry
import com.tribetails.auntieos.data.model.KinCareReport
import com.tribetails.auntieos.data.model.TrainingDocument
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.BookingTransitionAction
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

@OptIn(ExperimentalCoroutinesApi::class)
class AdminDataViewModelTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository
    private lateinit var mockInvoiceRepo: InvoiceRepository
    private lateinit var mockKinCareRepo: KinCareRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
        mockInvoiceRepo = mockk()
        mockKinCareRepo = mockk()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun buildViewModel() = AdminDataViewModel(repository = mockRepo, invoiceRepository = mockInvoiceRepo, kinCareRepository = mockKinCareRepo)

    // ─── Initial state ────────────────────────────────────────────────────────

    @Test
    fun `initial isLoading is false`() {
        val vm = buildViewModel()
        assertFalse(vm.isLoading.value)
    }

    @Test
    fun `initial error is null`() {
        val vm = buildViewModel()
        assertNull(vm.error.value)
    }

    // ─── loadInvoices ─────────────────────────────────────────────────────────

    @Test
    fun `loadInvoices populates invoices on success`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.getInvoices() } returns Result.success(listOf(TestFixtures.invoice1, TestFixtures.invoice2))

        val vm = buildViewModel()
        vm.loadInvoices()
        advanceUntilIdle()

        assertFalse(vm.isLoading.value)
        assertNull(vm.error.value)
        assertEquals(2, vm.invoices.value.size)
    }

    @Test
    fun `loadInvoices sets error on failure`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.getInvoices() } returns Result.failure(RuntimeException("Network error"))

        val vm = buildViewModel()
        vm.loadInvoices()
        advanceUntilIdle()

        assertFalse(vm.isLoading.value)
        assertNotNull(vm.error.value)
        assertTrue(vm.error.value!!.contains("Network error"))
    }

    // ─── loadPayments ─────────────────────────────────────────────────────────
    //
    // These read through the `listPayments` CALLABLE, not the raw root-collection
    // read this screen used to do. The distinction is the whole point of the
    // change: `stripeWebhook.ts` stores a card payment's `amount` in cents and a
    // fallback payment's in dollars, and the Kotlin `Payment` model carries no
    // field that can tell them apart, so anything rendering money out of it was
    // 100x wrong on every Stripe row. The server resolves the units and sends
    // integer cents; the assertions below are on VALUES for that reason.

    @Test
    fun `loadPayments populates payments on success, in the cents the server resolved`() =
        runTest(testDispatcher) {
            coEvery { mockInvoiceRepo.listPayments() } returns
                Result.success(TestFixtures.paymentsPage(TestFixtures.paymentRow("p1", 13750L)))

            val vm = buildViewModel()
            vm.loadPayments()
            advanceUntilIdle()

            assertFalse(vm.isLoading.value)
            assertNull(vm.error.value)
            assertEquals(1, vm.payments.value.rows.size)
            // $137.50, not $13,750.00.
            assertEquals(13750L, vm.payments.value.rows.single().amountCents)
        }

    @Test
    fun `loadPayments carries the truncation signal, so a bounded page cannot read as complete`() =
        runTest(testDispatcher) {
            coEvery { mockInvoiceRepo.listPayments() } returns
                Result.success(
                    TestFixtures.paymentsPage(
                        TestFixtures.paymentRow("p1", 100L),
                        truncated = true,
                        nextCursor = "p1",
                    ),
                )

            val vm = buildViewModel()
            vm.loadPayments()
            advanceUntilIdle()

            assertTrue(vm.payments.value.truncated)
            assertEquals("p1", vm.payments.value.nextCursor)
        }

    @Test
    fun `loadPayments carries the unresolved count rather than letting a zero read as a fact`() =
        runTest(testDispatcher) {
            coEvery { mockInvoiceRepo.listPayments() } returns
                Result.success(
                    TestFixtures.paymentsPage(
                        TestFixtures.paymentRow("p1", 0L, amountResolved = false),
                        unresolvedAmountCount = 1L,
                    ),
                )

            val vm = buildViewModel()
            vm.loadPayments()
            advanceUntilIdle()

            assertEquals(1L, vm.payments.value.unresolvedAmountCount)
            assertFalse(vm.payments.value.rows.single().amountResolved)
        }

    @Test
    fun `loadPayments sets error on failure`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.listPayments() } returns Result.failure(RuntimeException("Timeout"))

        val vm = buildViewModel()
        vm.loadPayments()
        advanceUntilIdle()

        assertNotNull(vm.error.value)
    }

    @Test
    fun `loadPayments leaves the previous page alone on failure rather than emptying it`() =
        runTest(testDispatcher) {
            // Fail-loud, not fail-soft: an emptied list reads on screen as "no
            // payments have ever been recorded", which is a false statement about
            // money rather than a missing one.
            coEvery { mockInvoiceRepo.listPayments() } returns
                Result.success(TestFixtures.paymentsPage(TestFixtures.paymentRow("p1", 13750L)))
            val vm = buildViewModel()
            vm.loadPayments()
            advanceUntilIdle()

            coEvery { mockInvoiceRepo.listPayments() } returns Result.failure(RuntimeException("Timeout"))
            vm.loadPayments()
            advanceUntilIdle()

            assertNotNull(vm.error.value)
            assertEquals(1, vm.payments.value.rows.size)
        }

    @Test
    fun `loadPayments never touches the raw root-collection read`() = runTest(testDispatcher) {
        // `getPayments()` is retained under the repo's payment-code rule, but it
        // returns ambiguous units and nothing on a screen may call it. `mockk()`
        // here is strict, so a call to it would fail this test outright; the
        // explicit verify says so on purpose rather than by accident.
        coEvery { mockInvoiceRepo.listPayments() } returns Result.success(TestFixtures.paymentsPage())

        val vm = buildViewModel()
        vm.loadPayments()
        advanceUntilIdle()

        coVerify(exactly = 0) { mockInvoiceRepo.getPayments() }
    }

    // ─── loadVisitLogs ────────────────────────────────────────────────────────

    @Test
    fun `loadVisitLogs populates visitLogs on success`() = runTest(testDispatcher) {
        coEvery { mockRepo.getVisitLogs() } returns Result.success(listOf(TestFixtures.visitLog1))

        val vm = buildViewModel()
        vm.loadVisitLogs()
        advanceUntilIdle()

        assertFalse(vm.isLoading.value)
        assertNull(vm.error.value)
        assertEquals(1, vm.visitLogs.value.size)
    }

    @Test
    fun `loadVisitLogs sets error on failure`() = runTest(testDispatcher) {
        coEvery { mockRepo.getVisitLogs() } returns Result.failure(RuntimeException("403"))

        val vm = buildViewModel()
        vm.loadVisitLogs()
        advanceUntilIdle()

        assertNotNull(vm.error.value)
    }

    // ─── loadTrainingDocuments ────────────────────────────────────────────────

    @Test
    fun `loadTrainingDocuments populates trainingDocuments on success`() = runTest(testDispatcher) {
        val doc = TrainingDocument(id = "td1", title = "Onboarding", uploadedAt = "2026-05-01")
        coEvery { mockRepo.getTrainingDocuments() } returns Result.success(listOf(doc))

        val vm = buildViewModel()
        vm.loadTrainingDocuments()
        advanceUntilIdle()

        assertFalse(vm.isLoading.value)
        assertNull(vm.error.value)
        assertEquals(1, vm.trainingDocuments.value.size)
    }

    @Test
    fun `loadTrainingDocuments sets error on failure`() = runTest(testDispatcher) {
        coEvery { mockRepo.getTrainingDocuments() } returns Result.failure(RuntimeException("Not found"))

        val vm = buildViewModel()
        vm.loadTrainingDocuments()
        advanceUntilIdle()

        assertNotNull(vm.error.value)
    }

    // ─── loadKinCareSessions ──────────────────────────────────────────────────

    @Test
    fun `loadKinCareSessions populates kinCareSessions on success`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.getKinCareSessions() } returns Result.success(listOf(TestFixtures.session1))

        val vm = buildViewModel()
        vm.loadKinCareSessions()
        advanceUntilIdle()

        assertFalse(vm.isLoading.value)
        assertNull(vm.error.value)
        assertEquals(1, vm.kinCareSessions.value.size)
    }

    @Test
    fun `loadKinCareSessions sets error on failure`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.getKinCareSessions() } returns Result.failure(RuntimeException("Server error"))

        val vm = buildViewModel()
        vm.loadKinCareSessions()
        advanceUntilIdle()

        assertNotNull(vm.error.value)
        assertTrue(vm.error.value!!.contains("Server error"))
    }

    // ─── loadKinCareReports ───────────────────────────────────────────────────

    @Test
    fun `loadKinCareReports populates kinCareReports on success`() = runTest(testDispatcher) {
        val report = KinCareReport(id = "r1", kinfolkId = "kf1", sentAt = "2026-05-01")
        coEvery { mockKinCareRepo.getAllKinCareReports() } returns Result.success(listOf(report))

        val vm = buildViewModel()
        vm.loadKinCareReports()
        advanceUntilIdle()

        assertFalse(vm.isLoading.value)
        assertNull(vm.error.value)
        assertEquals(1, vm.kinCareReports.value.size)
    }

    @Test
    fun `loadKinCareReports sets error on failure`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.getAllKinCareReports() } returns Result.failure(RuntimeException("KinTale load failed"))

        val vm = buildViewModel()
        vm.loadKinCareReports()
        advanceUntilIdle()

        assertNotNull(vm.error.value)
    }

    // ─── loadActivityLog ──────────────────────────────────────────────────────

    @Test
    fun `loadActivityLog populates activityLog on success`() = runTest(testDispatcher) {
        val entry = ActivityLogEntry(id = "al1", timestamp = "2026-05-01T09:00:00", actionType = "LOGIN")
        coEvery { mockRepo.getActivityLog() } returns Result.success(listOf(entry))

        val vm = buildViewModel()
        vm.loadActivityLog()
        advanceUntilIdle()

        assertFalse(vm.isLoading.value)
        assertNull(vm.error.value)
        assertEquals(1, vm.activityLog.value.size)
    }

    @Test
    fun `loadActivityLog sets error on failure`() = runTest(testDispatcher) {
        coEvery { mockRepo.getActivityLog() } returns Result.failure(RuntimeException("Auth error"))

        val vm = buildViewModel()
        vm.loadActivityLog()
        advanceUntilIdle()

        assertNotNull(vm.error.value)
    }

    // ─── loadNotifications ────────────────────────────────────────────────────

    @Test
    fun `loadNotifications populates notifications sorted by createdAt desc`() = runTest(testDispatcher) {
        val older = NotificationEntry(id = "n1", key = "invoice.new", createdAt = "2026-05-01T09:00:00")
        val newer = NotificationEntry(id = "n2", key = "kincare.booking.confirm", createdAt = "2026-05-02T09:00:00")
        coEvery { mockRepo.getNotifications() } returns Result.success(listOf(older, newer))

        val vm = buildViewModel()
        vm.loadNotifications()
        advanceUntilIdle()

        assertFalse(vm.isLoading.value)
        assertNull(vm.error.value)
        assertEquals(2, vm.notifications.value.size)
        assertEquals("n2", vm.notifications.value.first().id)
    }

    @Test
    fun `loadNotifications sets error on failure`() = runTest(testDispatcher) {
        coEvery { mockRepo.getNotifications() } returns Result.failure(RuntimeException("Permission denied"))

        val vm = buildViewModel()
        vm.loadNotifications()
        advanceUntilIdle()

        assertNotNull(vm.error.value)
        assertTrue(vm.notifications.value.isEmpty())
    }

    @Test
    fun `loadNotifications empty list still sets isLoading false`() = runTest(testDispatcher) {
        coEvery { mockRepo.getNotifications() } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.loadNotifications()
        advanceUntilIdle()

        assertFalse(vm.isLoading.value)
        assertTrue(vm.notifications.value.isEmpty())
    }

    // ─── patchKinCareSession ──────────────────────────────────────────────────

    @Test
    fun `patchKinCareSession triggers loadKinCareSessions and invokes onResult null on success`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.patchKinCareSession(any(), any()) } returns Result.success(Unit)
        coEvery { mockKinCareRepo.getKinCareSessions() } returns Result.success(listOf(TestFixtures.session1))

        val vm = buildViewModel()
        var callbackArg: Throwable? = Throwable("sentinel")
        vm.patchKinCareSession("ses1", mapOf("status" to "completed")) { callbackArg = it }
        advanceUntilIdle()

        assertNull(callbackArg)
        assertEquals(1, vm.kinCareSessions.value.size)
    }

    @Test
    fun `patchKinCareSession sets error and invokes onResult throwable on failure`() = runTest(testDispatcher) {
        val err = RuntimeException("Patch denied")
        coEvery { mockKinCareRepo.patchKinCareSession(any(), any()) } returns Result.failure(err)

        val vm = buildViewModel()
        var callbackArg: Throwable? = null
        vm.patchKinCareSession("ses1", mapOf("status" to "completed")) { callbackArg = it }
        advanceUntilIdle()

        assertNotNull(vm.error.value)
        assertEquals(err, callbackArg)
    }

    // ─── transitionBookingStatus (A3) ─────────────────────────────────────────
    //
    // Kept as its own block rather than folded into the patch tests above,
    // because the two are different kinds of write and that distinction is the
    // whole point of A3: a patch is a field edit the client owns, a transition
    // is a state change the server owns, audits, and can REFUSE.
    @Test
    fun `transitionBookingStatus forwards the action and reloads on success`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.transitionBookingStatus(any(), any(), any(), any()) } returns Result.success(Unit)
        coEvery { mockKinCareRepo.getKinCareSessions() } returns Result.success(listOf(TestFixtures.session1))
        val vm = buildViewModel()
        var callbackArg: Throwable? = Throwable("sentinel")
        vm.transitionBookingStatus("ses1", BookingTransitionAction.COMPLETE, completedAt = "2026-08-01T10:00:00Z") {
            callbackArg = it
        }
        advanceUntilIdle()
        assertNull(callbackArg)
        assertEquals(1, vm.kinCareSessions.value.size)
        coVerify {
            mockKinCareRepo.transitionBookingStatus(
                "ses1", BookingTransitionAction.COMPLETE, "2026-08-01T10:00:00Z", "",
            )
        }
    }
    @Test
    fun `transitionBookingStatus surfaces a server refusal verbatim and does not reload`() = runTest(testDispatcher) {
        val err = RuntimeException("Cannot COMPLETE a booking in status CANCELLED.")
        coEvery { mockKinCareRepo.transitionBookingStatus(any(), any(), any(), any()) } returns Result.failure(err)
        val vm = buildViewModel()
        var callbackArg: Throwable? = null
        vm.transitionBookingStatus("ses1", BookingTransitionAction.COMPLETE) { callbackArg = it }
        advanceUntilIdle()
        assertEquals("Cannot COMPLETE a booking in status CANCELLED.", vm.error.value)
        assertEquals(err, callbackArg)
        coVerify(exactly = 0) { mockKinCareRepo.getKinCareSessions() }
    }
    @Test
    fun `transitionBookingStatus never routes through the direct patch path`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.transitionBookingStatus(any(), any(), any(), any()) } returns Result.success(Unit)
        coEvery { mockKinCareRepo.getKinCareSessions() } returns Result.success(emptyList())
        buildViewModel().transitionBookingStatus("ses1", BookingTransitionAction.CANCEL)
        advanceUntilIdle()
        coVerify(exactly = 0) { mockKinCareRepo.patchKinCareSession(any(), any()) }
    }
    // ─── createInvoice ────────────────────────────────────────────────────────

    @Test
    fun `createInvoice refreshes invoices list on success`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.createInvoice(any()) } returns Result.success("inv-new")
        coEvery { mockInvoiceRepo.getInvoices() } returns Result.success(listOf(TestFixtures.invoice1))

        val vm = buildViewModel()
        vm.createInvoice(TestFixtures.invoice1)
        advanceUntilIdle()

        assertFalse(vm.isLoading.value)
        assertEquals(1, vm.invoices.value.size)
    }

    @Test
    fun `createInvoice sets error on failure`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.createInvoice(any()) } returns Result.failure(RuntimeException("Write failed"))

        val vm = buildViewModel()
        vm.createInvoice(TestFixtures.invoice1)
        advanceUntilIdle()

        assertNotNull(vm.error.value)
        assertFalse(vm.isLoading.value)
    }

    // ─── createQuote (Step 4 PART B) ──────────────────────────────────────────

    @Test
    fun `createQuote routes through repository and refreshes on success`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.createQuote(any(), any()) } returns Result.success("q-new")
        coEvery { mockInvoiceRepo.getInvoices() } returns Result.success(listOf(TestFixtures.invoice1))

        val vm = buildViewModel()
        vm.createQuote(TestFixtures.invoice1, sendToKinfolk = true)
        advanceUntilIdle()

        coVerify(exactly = 1) { mockInvoiceRepo.createQuote(any(), true) }
        assertFalse(vm.isLoading.value)
        assertEquals(1, vm.invoices.value.size)
        assertEquals("Quote created and sent.", vm.invoiceActionMessage.value)
    }

    @Test
    fun `createQuote without send confirms quietly`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.createQuote(any(), any()) } returns Result.success("q-new")
        coEvery { mockInvoiceRepo.getInvoices() } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.createQuote(TestFixtures.invoice1, sendToKinfolk = false)
        advanceUntilIdle()

        coVerify(exactly = 1) { mockInvoiceRepo.createQuote(any(), false) }
        assertEquals("Quote created.", vm.invoiceActionMessage.value)
    }

    @Test
    fun `createQuote sets error on failure`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.createQuote(any(), any()) } returns Result.failure(RuntimeException("quote failed"))

        val vm = buildViewModel()
        vm.createQuote(TestFixtures.invoice1, sendToKinfolk = false)
        advanceUntilIdle()

        assertNotNull(vm.error.value)
        assertTrue(vm.error.value!!.contains("quote failed"))
        assertFalse(vm.isLoading.value)
    }

    // ─── composeInvoice (#408) ────────────────────────────────────────────────

    @Test
    fun `composeInvoice routes an invoice request through createInvoice and hands back the id`() =
        runTest(testDispatcher) {
            coEvery {
                mockInvoiceRepo.createInvoice(any(), any(), any(), any())
            } returns Result.success("inv-new")
            coEvery { mockInvoiceRepo.getInvoices() } returns Result.success(listOf(TestFixtures.invoice1))

            val vm = buildViewModel()
            var handed: Result<String>? = null
            vm.composeInvoice(
                NewInvoiceRequest(
                    kind = InvoiceCreateKind.INVOICE,
                    invoice = TestFixtures.invoice1,
                    termsCode = "net_14",
                    lineItems = listOf(
                        com.tribetails.auntieos.data.model.InvoiceLineItem("Dog walk", 1.0, 2500L, sessionId = "s1"),
                    ),
                    invoiceDiscountCents = 0L,
                ),
            ) { handed = it }
            advanceUntilIdle()

            coVerify(exactly = 1) { mockInvoiceRepo.createInvoice(any(), "net_14", any(), 0L) }
            coVerify(exactly = 0) { mockInvoiceRepo.createQuote(any(), any(), any(), any(), any()) }
            // The caller needs the id: the point of creating an invoice is to
            // land on it.
            assertEquals("inv-new", handed!!.getOrNull())
            assertEquals(
                "Invoice created as a draft. Nothing has been sent to the household yet.",
                vm.invoiceActionMessage.value,
            )
        }

    @Test
    fun `composeInvoice routes a quote request through createQuote`() = runTest(testDispatcher) {
        coEvery {
            mockInvoiceRepo.createQuote(any(), any(), any(), any(), any())
        } returns Result.success("q-new")
        coEvery { mockInvoiceRepo.getInvoices() } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.composeInvoice(
            NewInvoiceRequest(
                kind = InvoiceCreateKind.QUOTE,
                invoice = TestFixtures.invoice1,
                sendToKinfolk = true,
                termsCode = "due_on_receipt",
            ),
        )
        advanceUntilIdle()

        coVerify(exactly = 1) { mockInvoiceRepo.createQuote(any(), true, "due_on_receipt", null, null) }
        assertEquals("Quote created and sent.", vm.invoiceActionMessage.value)
    }

    @Test
    fun `composeInvoice reports a refusal to the caller as well as to the error flow`() =
        runTest(testDispatcher) {
            coEvery {
                mockInvoiceRepo.createInvoice(any(), any(), any(), any())
            } returns Result.failure(RuntimeException("due date disagrees with the terms"))

            val vm = buildViewModel()
            var handed: Result<String>? = null
            vm.composeInvoice(
                NewInvoiceRequest(kind = InvoiceCreateKind.INVOICE, invoice = TestFixtures.invoice1),
            ) { handed = it }
            advanceUntilIdle()

            // The dialog needs the failure so it can stay open with the form
            // intact rather than closing over a write that never happened.
            assertTrue(handed!!.isFailure)
            assertTrue(vm.error.value!!.contains("due date disagrees with the terms"))
            assertFalse(vm.isLoading.value)
        }

    // ─── notification quick actions (Step 4 PART A) ───────────────────────────

    @Test
    fun `toggleNotificationRead marks read and reloads when currently unread`() = runTest(testDispatcher) {
        coEvery { mockRepo.markNotificationRead("n1") } returns Result.success(Unit)
        coEvery { mockRepo.getNotifications() } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.toggleNotificationRead("n1", currentlyUnread = true)
        advanceUntilIdle()

        coVerify(exactly = 1) { mockRepo.markNotificationRead("n1") }
        assertEquals("Marked read.", vm.bulkReadMessage.value)
    }

    @Test
    fun `toggleNotificationRead marks unread when currently read`() = runTest(testDispatcher) {
        coEvery { mockRepo.markNotificationUnread("n1") } returns Result.success(Unit)
        coEvery { mockRepo.getNotifications() } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.toggleNotificationRead("n1", currentlyUnread = false)
        advanceUntilIdle()

        coVerify(exactly = 1) { mockRepo.markNotificationUnread("n1") }
        assertEquals("Marked unread.", vm.bulkReadMessage.value)
    }

    @Test
    fun `toggleNotificationRead surfaces failure loudly`() = runTest(testDispatcher) {
        coEvery { mockRepo.markNotificationRead("n1") } returns Result.failure(RuntimeException("nope"))

        val vm = buildViewModel()
        vm.toggleNotificationRead("n1", currentlyUnread = true)
        advanceUntilIdle()

        assertTrue(vm.bulkReadMessage.value!!.contains("nope"))
    }

    @Test
    fun `archiveNotification dismisses and reloads`() = runTest(testDispatcher) {
        coEvery { mockRepo.archiveNotification("n1") } returns Result.success(1)
        coEvery { mockRepo.getNotifications() } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.archiveNotification("n1")
        advanceUntilIdle()

        coVerify(exactly = 1) { mockRepo.archiveNotification("n1") }
        assertEquals("Dismissed.", vm.bulkReadMessage.value)
    }

    @Test
    fun `archiveNotification reports nothing when stale`() = runTest(testDispatcher) {
        coEvery { mockRepo.archiveNotification("n1") } returns Result.success(0)
        coEvery { mockRepo.getNotifications() } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.archiveNotification("n1")
        advanceUntilIdle()

        assertTrue(vm.bulkReadMessage.value!!.contains("Nothing to dismiss"))
    }

    @Test
    fun `archiveNotifications bulk summarizes server count`() = runTest(testDispatcher) {
        coEvery { mockRepo.bulkArchiveNotifications(any()) } returns Result.success(2)
        coEvery { mockRepo.getNotifications() } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.archiveNotifications(listOf("n1", "n2", "n3"))
        advanceUntilIdle()

        coVerify(exactly = 1) { mockRepo.bulkArchiveNotifications(listOf("n1", "n2", "n3")) }
        assertEquals("Dismissed 2 of 3.", vm.bulkReadMessage.value)
        assertFalse(vm.bulkReadInFlight.value)
    }

    @Test
    fun `quickBookingAction approves the linked booking`() = runTest(testDispatcher) {
        coEvery { mockRepo.batchUpdateBookings(listOf("bk-1"), "APPROVE") } returns
            Result.success(com.tribetails.auntieos.data.repository.BatchBookingResult("APPROVE", 1, emptyList()))
        coEvery { mockRepo.getNotifications() } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.quickBookingAction("bk-1", "APPROVE")
        advanceUntilIdle()

        coVerify(exactly = 1) { mockRepo.batchUpdateBookings(listOf("bk-1"), "APPROVE") }
        assertEquals("Booking approve.", vm.bulkReadMessage.value)
    }

    @Test
    fun `quickBookingAction surfaces a per-id failure`() = runTest(testDispatcher) {
        coEvery { mockRepo.batchUpdateBookings(listOf("bk-1"), "REJECT") } returns
            Result.success(
                com.tribetails.auntieos.data.repository.BatchBookingResult(
                    "REJECT", 0,
                    listOf(com.tribetails.auntieos.data.repository.BatchBookingFailure("bk-1", "already_cancelled")),
                ),
            )
        coEvery { mockRepo.getNotifications() } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.quickBookingAction("bk-1", "REJECT")
        advanceUntilIdle()

        assertTrue(vm.bulkReadMessage.value!!.contains("already_cancelled"))
    }

    // ─── generateReceipt (slice 2) ────────────────────────────────────────────

    @Test
    fun `generateReceipt routes through repository and refreshes invoices on success`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.generateReceipt("inv-1") } returns Result.success(Unit)
        coEvery { mockInvoiceRepo.getInvoices() } returns Result.success(listOf(TestFixtures.invoice1))

        val vm = buildViewModel()
        vm.generateReceipt("inv-1")
        advanceUntilIdle()

        coVerify(exactly = 1) { mockInvoiceRepo.generateReceipt("inv-1") }
        assertFalse(vm.isLoading.value)
        assertNull(vm.error.value)
        assertEquals(1, vm.invoices.value.size)
    }

    @Test
    fun `generateReceipt sets error on failure`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.generateReceipt(any()) } returns Result.failure(RuntimeException("not-found"))

        val vm = buildViewModel()
        vm.generateReceipt("missing")
        advanceUntilIdle()

        assertNotNull(vm.error.value)
        assertTrue(vm.error.value!!.contains("not-found"))
        assertFalse(vm.isLoading.value)
    }

    // ─── createPayment ────────────────────────────────────────────────────────

    @Test
    fun `createPayment refreshes payments list on success`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.createPayment(any()) } returns Result.success("pay-new")
        coEvery { mockInvoiceRepo.listPayments() } returns
            Result.success(TestFixtures.paymentsPage(TestFixtures.paymentRow("p1", 13750L)))

        val vm = buildViewModel()
        vm.createPayment(TestFixtures.payment1)
        advanceUntilIdle()

        assertFalse(vm.isLoading.value)
        assertEquals(1, vm.payments.value.rows.size)
    }

    @Test
    fun `createPayment sets error on failure`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.createPayment(any()) } returns Result.failure(RuntimeException("Write failed"))

        val vm = buildViewModel()
        vm.createPayment(TestFixtures.payment1)
        advanceUntilIdle()

        assertNotNull(vm.error.value)
    }

    // ─── createVisitLog ───────────────────────────────────────────────────────

    @Test
    fun `createVisitLog refreshes visitLogs list on success`() = runTest(testDispatcher) {
        coEvery { mockRepo.createVisitLog(any()) } returns Result.success("vl-new")
        coEvery { mockRepo.getVisitLogs() } returns Result.success(listOf(TestFixtures.visitLog1))

        val vm = buildViewModel()
        vm.createVisitLog(TestFixtures.visitLog1)
        advanceUntilIdle()

        assertFalse(vm.isLoading.value)
        assertEquals(1, vm.visitLogs.value.size)
    }

    @Test
    fun `createVisitLog sets error on failure`() = runTest(testDispatcher) {
        coEvery { mockRepo.createVisitLog(any()) } returns Result.failure(RuntimeException("Write failed"))

        val vm = buildViewModel()
        vm.createVisitLog(TestFixtures.visitLog1)
        advanceUntilIdle()

        assertNotNull(vm.error.value)
    }

    // ─── createKinCareSession ─────────────────────────────────────────────────

    @Test
    fun `createKinCareSession refreshes sessions list on success`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.createKinCareSession(any()) } returns Result.success("ses-new")
        coEvery { mockKinCareRepo.getKinCareSessions() } returns Result.success(listOf(TestFixtures.session1))

        val vm = buildViewModel()
        vm.createKinCareSession(TestFixtures.session1)
        advanceUntilIdle()

        assertFalse(vm.isLoading.value)
        assertEquals(1, vm.kinCareSessions.value.size)
    }

    @Test
    fun `createKinCareSession sets error on failure`() = runTest(testDispatcher) {
        coEvery { mockKinCareRepo.createKinCareSession(any()) } returns Result.failure(RuntimeException("Write failed"))

        val vm = buildViewModel()
        vm.createKinCareSession(TestFixtures.session1)
        advanceUntilIdle()

        assertNotNull(vm.error.value)
    }

    // ─── clearError ───────────────────────────────────────────────────────────

    @Test
    fun `clearError resets error to null`() = runTest(testDispatcher) {
        coEvery { mockInvoiceRepo.getInvoices() } returns Result.failure(RuntimeException("oops"))

        val vm = buildViewModel()
        vm.loadInvoices()
        advanceUntilIdle()
        assertNotNull("precondition: error should be set", vm.error.value)

        vm.clearError()

        assertNull(vm.error.value)
    }
}
