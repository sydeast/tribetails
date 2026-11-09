package com.tribetails.auntieos.ui.admin

import com.google.firebase.functions.FirebaseFunctionsException
import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/**
 * #1764: the Settings Business hours panel reads and writes
 * `business_settings.businessHours` through the Settings save
 * (`updateBusinessSettingsFields` -> `saveBusinessSettings`), never the old
 * `business_hours` collection.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AdminSettingsViewModelBusinessHoursTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository
    private val changes = slot<Map<String, Any?>>()

    private val week = mapOf(
        "Monday" to "09:00-17:00",
        "Tuesday" to "9:00-17:00",
        "Wednesday" to "09:00-17:00",
        "Thursday" to "09:00-17:00",
        "Friday" to "09:00-15:00",
        "Saturday" to "",
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun loaded(hours: Map<String, String>): AdminSettingsViewModel {
        coEvery { mockRepo.getBusinessSettings() } returns Result.success(BusinessSettings(businessName = "Den", businessHours = hours))
        return AdminSettingsViewModel(repository = mockRepo).also { it.loadBusinessSettings() }
    }

    private fun acceptSaves() {
        coEvery { mockRepo.updateBusinessSettingsFields(capture(changes), any()) } returns Result.success(Unit)
    }

    private fun refusal(sentence: String): FirebaseFunctionsException {
        val e = mockk<FirebaseFunctionsException>()
        every { e.message } returns sentence
        every { e.details } returns mapOf(
            "code" to "settings_refused",
            "field" to "businessHours",
            "refusals" to listOf(mapOf("field" to "businessHours", "message" to sentence)),
        )
        return e
    }

    // ── Happy ────────────────────────────────────────────────────────────────

    @Test
    fun `the panel reads the week from the settings map, Monday first`() = runTest(testDispatcher) {
        val vm = loaded(week)
        val rows = vm.uiState.value.businessHours
        assertEquals((1..7).toList(), rows.map { it.dayOfWeek })
        assertEquals(WeeklyHoursRow(1, DayHoursKind.OPEN, "09:00", "17:00"), rows[0])
        assertEquals(WeeklyHoursRow(2, DayHoursKind.OPEN, "09:00", "17:00"), rows[1])
        assertEquals(DayHoursKind.CLOSED, rows[5].kind)
        assertEquals(DayHoursKind.NOT_SET, rows[6].kind)
    }

    @Test
    fun `save sends only the day that changed, through the Settings save`() = runTest(testDispatcher) {
        acceptSaves()
        val vm = loaded(week)
        vm.setBusinessHourRow(vm.uiState.value.businessHours[0].copy(openTime = "8:30"))
        vm.saveBusinessHours()
        advanceUntilIdle()

        assertEquals(mapOf("businessHours" to mapOf("Monday" to "08:30-17:00")), changes.captured)
        assertTrue(vm.uiState.value.saveSuccess)
        assertEquals("08:30-17:00", vm.uiState.value.businessSettings.businessHours["Monday"])
        // An untouched day keeps its exact stored text.
        assertEquals("9:00-17:00", vm.uiState.value.businessSettings.businessHours["Tuesday"])
    }

    @Test
    fun `closing a day writes a blank, and setting a day that was not set adds its key`() = runTest(testDispatcher) {
        acceptSaves()
        val vm = loaded(week)
        vm.setBusinessHourRow(vm.uiState.value.businessHours[4].copy(kind = DayHoursKind.CLOSED))
        vm.setBusinessHourRow(WeeklyHoursRow(7, DayHoursKind.OPEN, "10:00", "14:00"))
        vm.saveBusinessHours()
        advanceUntilIdle()

        assertEquals(
            mapOf("businessHours" to mapOf("Friday" to "", "Sunday" to "10:00-14:00")),
            changes.captured,
        )
    }

    @Test
    fun `a second save after a first sends only its own day`() = runTest(testDispatcher) {
        acceptSaves()
        val vm = loaded(week)
        vm.setBusinessHourRow(vm.uiState.value.businessHours[0].copy(closeTime = "18:00"))
        vm.saveBusinessHours()
        advanceUntilIdle()
        vm.setBusinessHourRow(vm.uiState.value.businessHours[2].copy(closeTime = "16:00"))
        vm.saveBusinessHours()
        advanceUntilIdle()

        assertEquals(mapOf("businessHours" to mapOf("Wednesday" to "09:00-16:00")), changes.captured)
    }

    @Test
    fun `nothing changed writes nothing and still reports saved`() = runTest(testDispatcher) {
        val vm = loaded(week)
        vm.saveBusinessHours()
        advanceUntilIdle()

        coVerify(exactly = 0) { mockRepo.updateBusinessSettingsFields(any(), any()) }
        assertTrue(vm.uiState.value.saveSuccess)
    }

    @Test
    fun `setBusinessHourRow edits the draft only`() = runTest(testDispatcher) {
        val vm = loaded(week)
        vm.setBusinessHourRow(vm.uiState.value.businessHours[0].copy(openTime = "10:30"))

        assertEquals("10:30", vm.uiState.value.businessHours[0].openTime)
        assertEquals("09:00-17:00", vm.uiState.value.businessSettings.businessHours["Monday"])
        coVerify(exactly = 0) { mockRepo.updateBusinessSettingsFields(any(), any()) }
    }

    // ── Sad: no hours yet ─────────────────────────────────────────────────────

    @Test
    fun `a business with no hours map shows every day as not set, not 9 to 5`() = runTest(testDispatcher) {
        val vm = loaded(emptyMap())
        val rows = vm.uiState.value.businessHours
        assertEquals(7, rows.size)
        assertTrue(rows.all { it.kind == DayHoursKind.NOT_SET && it.openTime.isEmpty() && it.closeTime.isEmpty() })
        assertTrue(noWeeklyHoursSet(rows))
    }

    @Test
    fun `saving an untouched empty week writes nothing, so no day is turned into Closed`() = runTest(testDispatcher) {
        val vm = loaded(emptyMap())
        vm.saveBusinessHours()
        advanceUntilIdle()
        coVerify(exactly = 0) { mockRepo.updateBusinessSettingsFields(any(), any()) }
    }

    // ── Negative: refused before the write ───────────────────────────────────

    @Test
    fun `a close before the open is refused with the server sentence and nothing is sent`() = runTest(testDispatcher) {
        val vm = loaded(week)
        vm.setBusinessHourRow(vm.uiState.value.businessHours[0].copy(openTime = "18:00", closeTime = "09:00"))

        assertEquals(HOURS_CLOSE_BEFORE_OPEN, vm.uiState.value.businessHours[0].problem)
        vm.saveBusinessHours()
        advanceUntilIdle()

        assertEquals("Monday: $HOURS_CLOSE_BEFORE_OPEN", vm.uiState.value.error)
        assertFalse(vm.uiState.value.saveSuccess)
        coVerify(exactly = 0) { mockRepo.updateBusinessSettingsFields(any(), any()) }
    }

    @Test
    fun `an open day with a time missing is refused`() = runTest(testDispatcher) {
        val vm = loaded(emptyMap())
        vm.setBusinessHourRow(WeeklyHoursRow(3, DayHoursKind.OPEN, "09:00", ""))
        vm.saveBusinessHours()
        advanceUntilIdle()

        assertEquals("Wednesday: $HOURS_RANGE_INVALID", vm.uiState.value.error)
        coVerify(exactly = 0) { mockRepo.updateBusinessSettingsFields(any(), any()) }
    }

    @Test
    fun `a stored value the parser cannot read shows its sentence on open and holds Save`() = runTest(testDispatcher) {
        val vm = loaded(week + ("Sunday" to "9am-5pm"))
        val sunday = vm.uiState.value.businessHours[6]

        assertEquals(DayHoursKind.OPEN, sunday.kind)
        assertEquals("9am", sunday.openTime)
        assertEquals("5pm", sunday.closeTime)
        assertEquals(HOURS_RANGE_INVALID, sunday.problem)

        vm.setBusinessHourRow(vm.uiState.value.businessHours[0].copy(closeTime = "18:00"))
        vm.saveBusinessHours()
        advanceUntilIdle()
        assertEquals("Sunday: $HOURS_RANGE_INVALID", vm.uiState.value.error)
        coVerify(exactly = 0) { mockRepo.updateBusinessSettingsFields(any(), any()) }
    }

    // ── Error: the server says no, or the write fails ─────────────────────────

    @Test
    fun `a server refusal is its sentence, the draft stays, the saved copy does not move`() = runTest(testDispatcher) {
        val sentence = "Monday: $HOURS_CLOSE_BEFORE_OPEN"
        coEvery { mockRepo.updateBusinessSettingsFields(any(), any()) } returns Result.failure(refusal(sentence))
        val vm = loaded(week)
        vm.setBusinessHourRow(vm.uiState.value.businessHours[0].copy(openTime = "07:00"))
        vm.saveBusinessHours()
        advanceUntilIdle()

        assertEquals(sentence, vm.uiState.value.error)
        assertEquals(SettingsRefusal("businessHours", sentence), vm.uiState.value.settingsRefusal)
        assertEquals(1 to HOURS_CLOSE_BEFORE_OPEN, weeklyHoursRefusal(vm.uiState.value.settingsRefusal))
        assertEquals("07:00", vm.uiState.value.businessHours[0].openTime)
        assertEquals("09:00-17:00", vm.uiState.value.businessSettings.businessHours["Monday"])
        assertFalse(vm.uiState.value.saveSuccess)
    }

    @Test
    fun `a failed write keeps the lead-in and the retry still carries the edit`() = runTest(testDispatcher) {
        coEvery { mockRepo.updateBusinessSettingsFields(any(), any()) } returns Result.failure(RuntimeException("offline"))
        val vm = loaded(week)
        vm.setBusinessHourRow(vm.uiState.value.businessHours[0].copy(openTime = "07:00"))
        vm.saveBusinessHours()
        advanceUntilIdle()

        assertEquals("Failed to save business hours: offline", vm.uiState.value.error)

        acceptSaves()
        vm.saveBusinessHours()
        advanceUntilIdle()
        assertEquals(mapOf("businessHours" to mapOf("Monday" to "07:00-17:00")), changes.captured)
        assertTrue(vm.uiState.value.saveSuccess)
    }

    @Test
    fun `saving before settings ever loaded is refused`() = runTest(testDispatcher) {
        coEvery { mockRepo.getBusinessSettings() } returns Result.failure(RuntimeException("net"))
        val vm = AdminSettingsViewModel(repository = mockRepo).also { it.loadBusinessSettings() }
        assertTrue(vm.uiState.value.businessHours.isEmpty())

        vm.saveBusinessHours()
        advanceUntilIdle()
        coVerify(exactly = 0) { mockRepo.updateBusinessSettingsFields(any(), any()) }
    }
}
