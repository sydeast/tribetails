package com.tribetails.auntieos.ui.admin.services

import com.google.firebase.functions.FirebaseFunctionsException
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.ServiceRepository
import com.tribetails.auntieos.ui.admin.DayHoursKind
import com.tribetails.auntieos.ui.admin.HOURS_CLOSE_BEFORE_OPEN
import com.tribetails.auntieos.ui.admin.HOURS_RANGE_INVALID
import com.tribetails.auntieos.ui.admin.WeeklyHoursRow
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #1764: the Services screen's Edit hours dialog saves one day to
 * `business_settings.businessHours` through the Settings save, the same map
 * the Settings panel, the web and the phone line read.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ServiceManagementBusinessHoursTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var serviceRepo: ServiceRepository
    private lateinit var auntieRepo: AuntieRepository
    private val changes = slot<Map<String, Any?>>()

    private val stored = mapOf("Monday" to "09:00-17:00", "Tuesday" to "9:00-17:00", "Saturday" to "")

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        serviceRepo = mockk()
        auntieRepo = mockk()
        coEvery { serviceRepo.getBaseServices(any()) } returns Result.success(emptyList())
        coEvery { serviceRepo.getSupplementalServices(any()) } returns Result.success(emptyList())
        coEvery { serviceRepo.getSurcharges(any()) } returns Result.success(emptyList())
        coEvery { serviceRepo.getDiscounts(any()) } returns Result.success(emptyList())
        coEvery { serviceRepo.getPromoCodes(any()) } returns Result.success(emptyList())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun vm(hours: Map<String, String> = stored): ServiceManagementViewModel {
        coEvery { auntieRepo.getBusinessSettings() } returns Result.success(BusinessSettings(businessHours = hours))
        return ServiceManagementViewModel(serviceRepository = serviceRepo, auntieRepository = auntieRepo)
    }

    @Test
    fun `the cards read the week from the settings map`() = runTest(testDispatcher) {
        val rows = vm().state.value.businessHours
        assertEquals((1..7).toList(), rows.map { it.dayOfWeek })
        assertEquals(WeeklyHoursRow(2, DayHoursKind.OPEN, "09:00", "17:00"), rows[1])
        assertEquals("Closed", rows[5].display)
        assertEquals("Not set", rows[6].display)
    }

    @Test
    fun `no hours map shows every day as not set`() = runTest(testDispatcher) {
        val rows = vm(emptyMap()).state.value.businessHours
        assertTrue(rows.all { it.kind == DayHoursKind.NOT_SET })
    }

    @Test
    fun `saving a day sends that day alone and the card shows it`() = runTest(testDispatcher) {
        coEvery { auntieRepo.updateBusinessSettingsFields(capture(changes), any()) } returns Result.success(Unit)
        val vm = vm()
        vm.updateBusinessHours(WeeklyHoursRow(3, DayHoursKind.OPEN, "8:00", "12:00"))
        advanceUntilIdle()

        assertEquals(mapOf("businessHours" to mapOf("Wednesday" to "08:00-12:00")), changes.captured)
        assertEquals("08:00-12:00", vm.state.value.businessHours[2].display)
        assertEquals("9:00-17:00", vm.state.value.businessSettings.businessHours["Tuesday"])
    }

    @Test
    fun `closing a day writes a blank`() = runTest(testDispatcher) {
        coEvery { auntieRepo.updateBusinessSettingsFields(capture(changes), any()) } returns Result.success(Unit)
        val vm = vm()
        vm.updateBusinessHours(vm.state.value.businessHours[0].copy(kind = DayHoursKind.CLOSED))
        advanceUntilIdle()

        assertEquals(mapOf("businessHours" to mapOf("Monday" to "")), changes.captured)
        assertEquals(DayHoursKind.CLOSED, vm.state.value.businessHours[0].kind)
    }

    @Test
    fun `saving a day as it is stored writes nothing`() = runTest(testDispatcher) {
        val vm = vm()
        vm.updateBusinessHours(vm.state.value.businessHours[1])
        advanceUntilIdle()
        coVerify(exactly = 0) { auntieRepo.updateBusinessSettingsFields(any(), any()) }
    }

    @Test
    fun `a close before the open is refused with the server sentence and nothing is sent`() = runTest(testDispatcher) {
        val vm = vm()
        vm.updateBusinessHours(WeeklyHoursRow(1, DayHoursKind.OPEN, "18:00", "09:00"))
        advanceUntilIdle()

        assertEquals("Monday: $HOURS_CLOSE_BEFORE_OPEN", vm.state.value.errorMessage)
        coVerify(exactly = 0) { auntieRepo.updateBusinessSettingsFields(any(), any()) }
    }

    @Test
    fun `an open day with no times is refused`() = runTest(testDispatcher) {
        val vm = vm(emptyMap())
        vm.updateBusinessHours(WeeklyHoursRow(7, DayHoursKind.OPEN))
        advanceUntilIdle()

        assertEquals("Sunday: $HOURS_RANGE_INVALID", vm.state.value.errorMessage)
        coVerify(exactly = 0) { auntieRepo.updateBusinessSettingsFields(any(), any()) }
    }

    @Test
    fun `a stored value the parser cannot read shows its sentence on the card`() = runTest(testDispatcher) {
        val sunday = vm(stored + ("Sunday" to "noon-ish")).state.value.businessHours[6]
        assertEquals(HOURS_RANGE_INVALID, sunday.problem)
        assertEquals("noon-ish", sunday.display)
    }

    @Test
    fun `a server refusal shows its sentence and the card keeps what is stored`() = runTest(testDispatcher) {
        val sentence = "Monday: $HOURS_CLOSE_BEFORE_OPEN"
        val e = mockk<FirebaseFunctionsException>()
        every { e.message } returns sentence
        every { e.details } returns mapOf(
            "code" to "settings_refused",
            "field" to "businessHours",
            "refusals" to listOf(mapOf("field" to "businessHours", "message" to sentence)),
        )
        coEvery { auntieRepo.updateBusinessSettingsFields(any(), any()) } returns Result.failure(e)
        val vm = vm()
        vm.updateBusinessHours(WeeklyHoursRow(1, DayHoursKind.OPEN, "07:00", "17:00"))
        advanceUntilIdle()

        assertEquals(sentence, vm.state.value.errorMessage)
        assertEquals("09:00-17:00", vm.state.value.businessHours[0].display)
    }

    @Test
    fun `a failed write says so and the card keeps what is stored`() = runTest(testDispatcher) {
        coEvery { auntieRepo.updateBusinessSettingsFields(any(), any()) } returns Result.failure(RuntimeException("offline"))
        val vm = vm()
        vm.updateBusinessHours(WeeklyHoursRow(1, DayHoursKind.OPEN, "07:00", "17:00"))
        advanceUntilIdle()

        assertEquals("Failed to update settings: offline", vm.state.value.errorMessage)
        assertEquals("09:00-17:00", vm.state.value.businessHours[0].display)
    }

    @Test
    fun `saving before the settings loaded is refused`() = runTest(testDispatcher) {
        coEvery { auntieRepo.getBusinessSettings() } returns Result.failure(RuntimeException("net"))
        val vm = ServiceManagementViewModel(serviceRepository = serviceRepo, auntieRepository = auntieRepo)
        vm.updateBusinessHours(WeeklyHoursRow(1, DayHoursKind.OPEN, "07:00", "17:00"))
        advanceUntilIdle()

        assertEquals("Reopen Services before saving: the settings doc was never loaded.", vm.state.value.errorMessage)
        coVerify(exactly = 0) { auntieRepo.updateBusinessSettingsFields(any(), any()) }
    }

    // ── #1978: a closed day reopens with the hours it had ────────────────────

    @Test
    fun `a closed day's card opens the dialog with the hours the server kept`() = runTest(testDispatcher) {
        coEvery { auntieRepo.getBusinessSettings() } returns Result.success(
            BusinessSettings(businessHours = stored, closedDayHours = mapOf("Saturday" to "10:00-14:00")),
        )
        val vm = ServiceManagementViewModel(serviceRepository = serviceRepo, auntieRepository = auntieRepo)
        val saturday = vm.state.value.businessHours[5]
        assertEquals("Closed", saturday.display)
        // What the Edit hours dialog seeds its two times from.
        assertEquals("10:00", saturday.openTime)
        assertEquals("14:00", saturday.closeTime)
    }

    @Test
    fun `a closed day with nothing kept opens the dialog blank`() = runTest(testDispatcher) {
        val saturday = vm().state.value.businessHours[5]
        assertEquals(WeeklyHoursRow(6, DayHoursKind.CLOSED), saturday)
        assertEquals(HOURS_RANGE_INVALID, saturday.copy(kind = DayHoursKind.OPEN).problem)
    }

    @Test
    fun `closing a day keeps its hours for the next time the dialog opens, and sends only the blank`() = runTest(testDispatcher) {
        coEvery { auntieRepo.updateBusinessSettingsFields(capture(changes), any()) } returns Result.success(Unit)
        val vm = vm()
        vm.updateBusinessHours(vm.state.value.businessHours[0].copy(kind = DayHoursKind.CLOSED))
        advanceUntilIdle()

        assertEquals(mapOf("businessHours" to mapOf("Monday" to "")), changes.captured)
        val monday = vm.state.value.businessHours[0]
        assertEquals(WeeklyHoursRow(1, DayHoursKind.CLOSED, "09:00", "17:00"), monday)

        // Reopened with those hours: the day goes back, and nothing stays kept.
        vm.updateBusinessHours(monday.copy(kind = DayHoursKind.OPEN))
        advanceUntilIdle()
        assertEquals(mapOf("businessHours" to mapOf("Monday" to "09:00-17:00")), changes.captured)
        assertTrue(vm.state.value.businessSettings.closedDayHours.isEmpty())
    }
}
