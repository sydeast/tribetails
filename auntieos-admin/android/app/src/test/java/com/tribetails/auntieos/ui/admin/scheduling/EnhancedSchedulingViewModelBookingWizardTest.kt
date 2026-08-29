package com.tribetails.auntieos.ui.admin.scheduling

import com.tribetails.auntieos.data.contracts.CreateMultiDateBookingRequestArgsBilling
import com.tribetails.auntieos.data.contracts.CreateMultiDateBookingRequestArgsCommunication
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.BOOKING_BUSY_CONFLICT_CODE
import com.tribetails.auntieos.data.repository.BookingRepository
import com.tribetails.auntieos.data.repository.BookingRequestRefusedException
import com.tribetails.auntieos.data.repository.COMPANY_HOLIDAY_CONFLICT_CODE
import com.tribetails.auntieos.data.repository.GoogleCalendarConnectionState
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.MultiDateBookingResult
import com.tribetails.auntieos.data.repository.NewBookingVisit
import com.tribetails.auntieos.data.repository.ServiceRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.flowOf
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
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.LocalDate

/**
 * D1: what the five-step wizard asks of the ViewModel. The happy path, the kin
 * read behind step 1, and the sad/negative/error cases, including the two server
 * refusals that behave differently on purpose: a busy clash may be overridden,
 * a closed date may not.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class EnhancedSchedulingViewModelBookingWizardTest {

    private val testDispatcher = UnconfinedTestDispatcher()

    private lateinit var bookingRepo: BookingRepository
    private lateinit var serviceRepo: ServiceRepository
    private lateinit var auntieRepo: AuntieRepository
    private lateinit var kinCareRepo: KinCareRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        bookingRepo = mockk()
        serviceRepo = mockk()
        auntieRepo = mockk()
        kinCareRepo = mockk()

        coEvery { serviceRepo.getBaseServices() } returns Result.success(emptyList())
        coEvery { serviceRepo.getSupplementalServices() } returns Result.success(emptyList())
        coEvery { serviceRepo.getBusinessHours() } returns Result.success(emptyList())
        coEvery { auntieRepo.getKinfolk() } returns Result.success(emptyList())
        coEvery { auntieRepo.isTestAdminActive() } returns false
        coEvery { auntieRepo.getBusinessSettings() } returns Result.success(BusinessSettings())
        coEvery { auntieRepo.getCalendarSyncRun() } returns Result.success(null)
        coEvery { auntieRepo.updateBusinessSettingsFields(any(), any()) } returns Result.success(Unit)
        coEvery { auntieRepo.logActivity(any()) } returns Result.success(Unit)
        coEvery { bookingRepo.getBookings(any(), any(), any(), any()) } returns Result.success(emptyList())
        coEvery { bookingRepo.getTimeSlots(any(), any(), any()) } returns Result.success(emptyList())
        every { bookingRepo.bookingTimeSlotsStream() } returns flowOf(Result.success(emptyList()))
        every { bookingRepo.incomingKinCareRequestsStream() } returns flowOf(Result.success(emptyList()))
        coEvery { bookingRepo.getGoogleCalendarConnection() } returns
            Result.success(GoogleCalendarConnectionState(GoogleCalendarConnection(), "", ""))
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun buildViewModel() = EnhancedSchedulingViewModel(
        bookingRepository = bookingRepo,
        serviceRepository = serviceRepo,
        auntieRepository = auntieRepo,
        kinCareRepository = kinCareRepo,
    )

    private val monday = LocalDate.of(2027, 8, 2)

    /** The chosen household's live Kin roster, as the wizard reads it. */
    private val roster = listOf("kin-a", "kin-b")

    /** A complete wizard state: household, kin, service, two dates, both switches, notes. */
    private fun readySubmission(): BookingWizardSubmission = bookingSubmission(
        BookingWizardState(kinfolkId = "kf1")
            .withAllKinMode(false)
            .toggleKin("kin-a")
            .withServiceName("Dog Walking")
            .toggleDate(monday)
            .toggleDate(monday.plusDays(1))
            .copy(emailConfirmation = true, timeVisibility = true, notes = "Gate code 1234"),
        roster,
    )

    private fun submit(vm: EnhancedSchedulingViewModel, s: BookingWizardSubmission) =
        vm.createBookingRequest(
            kinfolkId = s.kinfolkId,
            visits = s.visits,
            notes = s.notes,
            pattern = s.pattern,
            weeklyDays = s.weeklyDays,
            overrideBusyConflict = s.overrideBusyConflict,
            kinIds = s.kinIds,
            billing = s.billing,
            communication = s.communication,
        )

    // -----------------------------------------------------------------------
    // Happy path
    // -----------------------------------------------------------------------

    @Test
    fun `the whole happy path reaches the repository with every wizard field`() = runTest(testDispatcher) {
        coEvery {
            bookingRepo.createMultiDateBookingRequest(
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
            )
        } returns Result.success(MultiDateBookingResult("batch1", listOf("v1", "v2"), 2))

        val vm = buildViewModel()
        vm.showNewRequestDialog()
        submit(vm, readySubmission())
        advanceUntilIdle()

        coVerify {
            bookingRepo.createMultiDateBookingRequest(
                kinfolkId = "kf1",
                visits = match<List<NewBookingVisit>> { it.size == 2 && it.all { v -> v.serviceName == "Dog Walking" } },
                notes = "Gate code 1234",
                pattern = "individual",
                weeklyDays = null,
                kinIds = listOf("kin-a"),
                billing = CreateMultiDateBookingRequestArgsBilling("new-invoice"),
                communication = CreateMultiDateBookingRequestArgsCommunication(
                    emailConfirmation = true,
                    timeVisibility = true,
                ),
                overrideBusyConflict = false,
                idempotencyKey = any(),
            )
        }

        val state = vm.state.value
        assertFalse(state.newRequestInFlight)
        assertFalse("success closes the wizard", state.showNewRequestDialog)
        assertNull(state.newRequestError)
        assertFalse(state.newRequestBusyOverridable)
        assertNotNull(state.seriesActionMessage)
        assertTrue(state.seriesActionMessage!!.contains("2 visit(s)"))
    }

    // R1: the wizard no longer HAS an "empty kin selection" in the ordinary
    // case: nothing tapped means the whole household, and the roster goes on
    // the wire. The only empty payload left is a household with no Kin on file,
    // and that one is still sent as an omitted field rather than an empty array.
    @Test
    fun `covering every kin sends the whole roster, not an omitted field`() = runTest(testDispatcher) {
        coEvery {
            bookingRepo.createMultiDateBookingRequest(
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
            )
        } returns Result.success(MultiDateBookingResult("batch1", listOf("v1"), 1))

        val vm = buildViewModel()
        submit(
            vm,
            bookingSubmission(
                BookingWizardState(kinfolkId = "kf1").withServiceName("Dog Walking").toggleDate(monday),
                roster,
            ),
        )
        advanceUntilIdle()

        coVerify {
            bookingRepo.createMultiDateBookingRequest(
                any(), any(), any(), any(), any(), roster, any(), any(), any(), any(),
            )
        }
    }

    @Test
    fun `a household with no kin on file is sent as an omitted field, not an empty array`() = runTest(testDispatcher) {
        coEvery {
            bookingRepo.createMultiDateBookingRequest(
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
            )
        } returns Result.success(MultiDateBookingResult("batch1", listOf("v1"), 1))

        val vm = buildViewModel()
        submit(
            vm,
            bookingSubmission(
                BookingWizardState(kinfolkId = "kf1").withServiceName("Dog Walking").toggleDate(monday),
                emptyList(),
            ),
        )
        advanceUntilIdle()

        coVerify { bookingRepo.createMultiDateBookingRequest(any(), any(), any(), any(), any(), null, any(), any(), any(), any()) }
    }

    @Test
    fun `a second submit while one is in flight is ignored, so no booking is filed twice`() =
        runTest(testDispatcher) {
            // Held open, so the first request is genuinely still in flight when the
            // second arrives: a double tap on Create must not file two batches.
            val inFlight = CompletableDeferred<Result<MultiDateBookingResult>>()
            coEvery {
                bookingRepo.createMultiDateBookingRequest(
                    any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
                )
            } coAnswers { inFlight.await() }
            val vm = buildViewModel()
            vm.showNewRequestDialog()
            submit(vm, readySubmission())
            assertTrue(vm.state.value.newRequestInFlight)
            submit(vm, readySubmission())
            coVerify(exactly = 1) {
                bookingRepo.createMultiDateBookingRequest(
                    any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
                )
            }
            // Closing is refused while in flight too: the request is already sent.
            vm.hideNewRequestDialog()
            assertTrue(vm.state.value.showNewRequestDialog)
            inFlight.complete(Result.success(MultiDateBookingResult("batch1", listOf("v1"), 1)))
            advanceUntilIdle()
            assertFalse(vm.state.value.newRequestInFlight)
            assertFalse(vm.state.value.showNewRequestDialog)
        }

    // -----------------------------------------------------------------------
    // Server refusals
    // -----------------------------------------------------------------------

    @Test
    fun `a busy-conflict refusal is surfaced and offered as overridable`() = runTest(testDispatcher) {
        coEvery {
            bookingRepo.createMultiDateBookingRequest(
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
            )
        } returns Result.failure(
            BookingRequestRefusedException(
                BOOKING_BUSY_CONFLICT_CODE,
                "This time is not available: visit 1 conflicts with a Google Calendar busy block " +
                    "(8:00 AM to 12:00 PM).",
            ),
        )

        val vm = buildViewModel()
        vm.showNewRequestDialog()
        submit(vm, readySubmission())
        advanceUntilIdle()

        val state = vm.state.value
        assertFalse(state.newRequestInFlight)
        assertTrue("a refusal must not close the wizard", state.showNewRequestDialog)
        assertTrue(state.newRequestError!!.contains("Google Calendar busy block"))
        assertTrue("busy is the one refusal an operator may override", state.newRequestBusyOverridable)
    }

    @Test
    fun `Create anyway resubmits with the override and does not re-offer itself on a second failure`() =
        runTest(testDispatcher) {
            coEvery {
                bookingRepo.createMultiDateBookingRequest(
                    any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
                )
            } returns Result.failure(
                BookingRequestRefusedException(BOOKING_BUSY_CONFLICT_CODE, "busy"),
            )

            val vm = buildViewModel()
            submit(vm, readySubmission().copy(overrideBusyConflict = true))
            advanceUntilIdle()

            coVerify {
                bookingRepo.createMultiDateBookingRequest(
                    any(), any(), any(), any(), any(), any(), any(), any(), overrideBusyConflict = true, idempotencyKey = any(),
                )
            }
            assertFalse(
                "re-offering Create anyway after an override already failed offers a losing move twice",
                vm.state.value.newRequestBusyOverridable,
            )
        }

    @Test
    fun `Create anyway succeeds and closes the wizard`() = runTest(testDispatcher) {
        coEvery {
            bookingRepo.createMultiDateBookingRequest(
                any(), any(), any(), any(), any(), any(), any(), any(), overrideBusyConflict = true, idempotencyKey = any(),
            )
        } returns Result.success(MultiDateBookingResult("batch1", listOf("v1", "v2"), 2))

        val vm = buildViewModel()
        vm.showNewRequestDialog()
        submit(vm, readySubmission().copy(overrideBusyConflict = true))
        advanceUntilIdle()

        assertFalse(vm.state.value.showNewRequestDialog)
        assertNull(vm.state.value.newRequestError)
    }

    // -----------------------------------------------------------------------
    // #644: the booking idempotency key
    // -----------------------------------------------------------------------

    /**
     * The key is what makes a retry a repair instead of a second booking, so
     * what this view model gets right or wrong decides whether #630's dropped
     * request costs the household one booking or two. Two rules that pull
     * against each other: retrying the SAME booking must reuse the key, and
     * retrying a CHANGED one must not.
     */
    private fun captureKeys(failFirst: Boolean = false): MutableList<String?> {
        val keys = mutableListOf<String?>()
        coEvery {
            bookingRepo.createMultiDateBookingRequest(
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
            )
        } answers {
            // Positional: `idempotencyKey` is the tenth parameter. Read off the
            // call rather than captured into a slot, so a nullable argument
            // records as the null it was.
            keys.add(arg<String?>(9))
            if (failFirst && keys.size == 1) {
                Result.failure(BookingRequestRefusedException(BOOKING_BUSY_CONFLICT_CODE, "That window is busy."))
            } else {
                Result.success(MultiDateBookingResult("batch1", listOf("v1"), 1))
            }
        }
        return keys
    }

    @Test
    fun `every request carries a key in the id shape the server mints`() = runTest(testDispatcher) {
        val keys = captureKeys()
        val vm = buildViewModel()
        submit(vm, readySubmission())
        advanceUntilIdle()

        // A bare uuid is refused by the callable's zod guard, so a wrong shape
        // here is a booking that cannot be made at all.
        assertTrue(keys.single()!!.matches(Regex("^req_[0-9]{10,16}_[a-z0-9]{1,16}$")))
    }

    @Test
    fun `retrying the same booking reuses the key`() = runTest(testDispatcher) {
        val keys = captureKeys(failFirst = true)
        val vm = buildViewModel()
        submit(vm, readySubmission())
        advanceUntilIdle()
        submit(vm, readySubmission())
        advanceUntilIdle()

        // If the first attempt had in fact committed and only lost its reply,
        // this is what stops the second one becoming a second booking.
        assertEquals(2, keys.size)
        assertEquals(keys[0], keys[1])
    }

    @Test
    fun `Create anyway keeps the key of the refusal it is overriding`() = runTest(testDispatcher) {
        val keys = captureKeys(failFirst = true)
        val vm = buildViewModel()
        submit(vm, readySubmission())
        advanceUntilIdle()
        // A busy refusal wrote nothing, so the override is the SAME submission
        // -- and if that refusal had actually been a lost reply, the shared key
        // is what stops the override booking it twice.
        submit(vm, readySubmission().copy(overrideBusyConflict = true))
        advanceUntilIdle()

        assertEquals(keys[0], keys[1])
    }

    @Test
    fun `a booking that succeeded does not lend its key to the next one`() = runTest(testDispatcher) {
        val keys = captureKeys()
        val vm = buildViewModel()
        submit(vm, readySubmission())
        advanceUntilIdle()
        // The first booking exists now. An identical second one is a real
        // second booking the operator asked for, not a retry of the first.
        submit(vm, readySubmission())
        advanceUntilIdle()

        assertNotEquals(keys[0], keys[1])
    }

    @Test
    fun `a changed booking gets a new key`() = runTest(testDispatcher) {
        val keys = captureKeys(failFirst = true)
        val vm = buildViewModel()
        submit(vm, readySubmission())
        advanceUntilIdle()
        submit(vm, bookingSubmission(
            BookingWizardState(kinfolkId = "kf1")
                .withAllKinMode(false)
                .toggleKin("kin-a")
                .withServiceName("Dog Walking")
                .toggleDate(monday)
                .copy(emailConfirmation = true, timeVisibility = true, notes = "Gate code 5678"),
            roster,
        ))
        advanceUntilIdle()

        // Holding the key here would be the dangerous bug: the server would
        // replay the FIRST booking and report it as the edited one.
        assertEquals(2, keys.size)
        assertNotEquals(keys[0], keys[1])
    }

    @Test
    fun `a company-holiday refusal is surfaced but is NEVER overridable`() = runTest(testDispatcher) {
        coEvery {
            bookingRepo.createMultiDateBookingRequest(
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
            )
        } returns Result.failure(
            BookingRequestRefusedException(
                COMPANY_HOLIDAY_CONFLICT_CODE,
                "This date is not available: visit 1 (2027-08-02) falls on Founders Day. The business is closed.",
            ),
        )

        val vm = buildViewModel()
        submit(vm, readySubmission())
        advanceUntilIdle()

        val state = vm.state.value
        assertTrue(state.newRequestError!!.contains("The business is closed."))
        assertFalse(
            "guardCompanyHolidayConflict has no override parameter, so no retry may be offered",
            state.newRequestBusyOverridable,
        )
    }

    @Test
    fun `a refusal with no machine-readable code is not overridable`() = runTest(testDispatcher) {
        coEvery {
            bookingRepo.createMultiDateBookingRequest(
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
            )
        } returns Result.failure(BookingRequestRefusedException(null, "Kinfolk not found: kf1"))

        val vm = buildViewModel()
        submit(vm, readySubmission())
        advanceUntilIdle()

        assertEquals("Kinfolk not found: kf1", vm.state.value.newRequestError)
        assertFalse(vm.state.value.newRequestBusyOverridable)
    }

    @Test
    fun `a transport failure with no message still fails loud`() = runTest(testDispatcher) {
        coEvery {
            bookingRepo.createMultiDateBookingRequest(
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
            )
        } returns Result.failure(RuntimeException())

        val vm = buildViewModel()
        submit(vm, readySubmission())
        advanceUntilIdle()

        assertEquals("Failed to create the booking request.", vm.state.value.newRequestError)
        assertFalse(vm.state.value.newRequestBusyOverridable)
    }

    @Test
    fun `opening the wizard clears a refusal left over from last time`() = runTest(testDispatcher) {
        coEvery {
            bookingRepo.createMultiDateBookingRequest(
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
            )
        } returns Result.failure(BookingRequestRefusedException(BOOKING_BUSY_CONFLICT_CODE, "busy"))

        val vm = buildViewModel()
        submit(vm, readySubmission())
        advanceUntilIdle()
        assertTrue(vm.state.value.newRequestBusyOverridable)

        vm.showNewRequestDialog()
        assertNull(vm.state.value.newRequestError)
        assertFalse(vm.state.value.newRequestBusyOverridable)
    }

    // -----------------------------------------------------------------------
    // Step 1's kin read
    // -----------------------------------------------------------------------

    @Test
    fun `picking a household loads only its active kin`() = runTest(testDispatcher) {
        coEvery { auntieRepo.getKin("kf1") } returns Result.success(
            listOf(
                Kin(id = "kin-a", kinfolkId = "kf1", name = "Aggie", status = "active"),
                Kin(id = "kin-b", kinfolkId = "kf1", name = "Rex", status = "archived"),
            ),
        )

        val vm = buildViewModel()
        vm.loadKinForNewRequest("kf1")
        advanceUntilIdle()

        assertEquals(listOf("kin-a"), vm.state.value.newRequestKin.map { it.id })
        assertFalse(vm.state.value.newRequestKinLoading)
        assertNull(vm.state.value.newRequestKinError)
    }

    @Test
    fun `an unreadable kin roster fails loud rather than reading as an empty household`() =
        runTest(testDispatcher) {
            coEvery { auntieRepo.getKin("kf1") } returns Result.failure(RuntimeException("permission denied"))

            val vm = buildViewModel()
            vm.loadKinForNewRequest("kf1")
            advanceUntilIdle()

            assertEquals(emptyList<Kin>(), vm.state.value.newRequestKin)
            assertEquals("permission denied", vm.state.value.newRequestKinError)
            assertFalse(vm.state.value.newRequestKinLoading)
        }

    @Test
    fun `clearing the household empties the kin list without a read`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        vm.loadKinForNewRequest("")
        advanceUntilIdle()

        assertEquals(emptyList<Kin>(), vm.state.value.newRequestKin)
        coVerify(exactly = 0) { auntieRepo.getKin(any()) }
    }

    @Test
    fun `closing the wizard drops the kin roster and any refusal`() = runTest(testDispatcher) {
        coEvery { auntieRepo.getKin("kf1") } returns Result.success(
            listOf(Kin(id = "kin-a", kinfolkId = "kf1", name = "Aggie", status = "active")),
        )

        val vm = buildViewModel()
        vm.showNewRequestDialog()
        vm.loadKinForNewRequest("kf1")
        advanceUntilIdle()
        assertEquals(1, vm.state.value.newRequestKin.size)

        vm.hideNewRequestDialog()
        assertFalse(vm.state.value.showNewRequestDialog)
        assertEquals(emptyList<Kin>(), vm.state.value.newRequestKin)
        assertNull(vm.state.value.newRequestKinError)
    }
}
