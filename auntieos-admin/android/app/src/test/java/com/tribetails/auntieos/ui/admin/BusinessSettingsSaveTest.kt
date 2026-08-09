package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.TagColor
import com.tribetails.auntieos.data.model.TagDef
import com.tribetails.auntieos.data.model.encodeTagDefs
import com.tribetails.auntieos.data.model.withPetTagDefs
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.BookingRepository
import com.tribetails.auntieos.data.repository.GoogleCalendarConnectionState
import com.tribetails.auntieos.data.repository.KinCareRepository
import com.tribetails.auntieos.data.repository.ServiceRepository
import com.tribetails.auntieos.ui.admin.scheduling.EnhancedSchedulingViewModel
import com.tribetails.auntieos.ui.admin.scheduling.GoogleCalendarConnection
import com.tribetails.auntieos.ui.admin.services.ServiceManagementViewModel
import io.mockk.CapturingSlot
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
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
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Every settings save writes a DIFF, not the model it loaded.
 *
 * `business_settings/business_settings` is ONE document with many editors. The
 * android side used to hand it `.set(wholeModel, merge())` from four different
 * screens; `merge()` protects fields OUTSIDE the written map and does nothing
 * about stale fields inside it, so all ~46 writable fields went back at whatever
 * the phone read. The React admin patches the same document PER SECTION
 * (`auntieos-admin/src/api/settingsWrite.ts`), so any web edit made between a
 * phone's load and its save was silently reverted - including `calendarSyncId`,
 * the payment handles and both tag vocabularies.
 *
 * THE CONCURRENT-EDIT TESTS BELOW ARE THE LOAD-BEARING ONES. A test that only
 * checks "the edited field was written" passes on the broken code too.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AdminSettingsBusinessSettingsSaveTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository

    /** The document as it stood when the phone read it. */
    private val stored = BusinessSettings(
        businessName = "Tribe Tails",
        calendarSyncId = "old@group.calendar.google.com",
        venmoHandle = "@old-venmo",
        weatherLocation = "Austin, TX",
        brandWordmark = "AuntieOS",
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        coEvery { repo.getBusinessSettings() } returns Result.success(stored)
        coEvery { repo.updateBusinessSettingsFields(any(), any()) } returns Result.success(Unit)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun captureChanges(): CapturingSlot<Map<String, Any?>> {
        val changes = slot<Map<String, Any?>>()
        coEvery { repo.updateBusinessSettingsFields(capture(changes), any()) } returns Result.success(Unit)
        return changes
    }

    private fun loadedViewModel(): AdminSettingsViewModel {
        val vm = AdminSettingsViewModel(repository = repo)
        vm.loadBusinessSettings()
        return vm
    }

    @Test
    fun `a save writes only the field the operator edited`() = runTest(testDispatcher) {
        val changes = captureChanges()
        val vm = loadedViewModel()

        vm.updateBusinessSettings(vm.uiState.value.businessSettings.copy(venmoHandle = "@new-venmo"))
        advanceUntilIdle()

        assertEquals(mapOf<String, Any?>("venmoHandle" to "@new-venmo"), changes.captured)
        assertTrue(vm.uiState.value.saveSuccess)
    }

    /**
     * THE CONCURRENT-EDIT CASE, and the reason this fix exists.
     *
     * An operator opens Settings on the phone. While it sits there, someone
     * pastes the real shared-calendar id into the React admin's Calendar
     * section, so `calendarSyncId` is now `new@...` on the server while the
     * phone's copy still says `old@...`. The operator then saves ONE unrelated
     * field on the Payments panel.
     *
     * The write must not mention `calendarSyncId` at all. Naming it, even at the
     * value the phone honestly read, points the nightly Google Calendar sync back
     * at the old calendar - and a sync aimed at a calendar it cannot see reports
     * "Imported 0 busy blocks", which reads exactly like a clear week.
     */
    @Test
    fun `a calendar id set on the web after the load is not reverted by an unrelated save`() =
        runTest(testDispatcher) {
            val changes = captureChanges()
            val vm = loadedViewModel()   // phone holds calendarSyncId = "old@..."

            vm.updateBusinessSettings(vm.uiState.value.businessSettings.copy(venmoHandle = "@new-venmo"))
            advanceUntilIdle()

            // The whole-model write is the bug itself: every field it carries is
            // a field it reverts.
            assertFalse(
                "the stale calendar id must not be in the written map: ${changes.captured}",
                changes.captured.containsKey("calendarSyncId"),
            )
            assertEquals(setOf("venmoHandle"), changes.captured.keys)
        }

    /** Branding commits five fields; it must still not carry the other forty-one. */
    @Test
    fun `saving branding leaves a concurrently edited payment handle alone`() = runTest(testDispatcher) {
        val changes = captureChanges()
        val vm = loadedViewModel()   // phone holds venmoHandle = "@old-venmo"

        vm.saveBranding("Tribe Tails", "Care with a capital C", "Morning", "Auntie.")
        advanceUntilIdle()

        assertFalse(
            "the stale venmo handle must not be in the written map: ${changes.captured}",
            changes.captured.containsKey("venmoHandle"),
        )
        assertEquals(
            setOf("brandWordmark", "brandTagline", "homeGreeting", "homeAccentTail"),
            changes.captured.keys,
        )
    }

    /**
     * NOTHING CHANGED MEANS NOTHING IS WRITTEN, not even the stamp. `updatedAt`
     * says when the doc last changed; moving it for a save that changed nothing
     * makes it lie. The Business Operations panel's Save button re-submits the
     * settings object unchanged, so this is a button an operator can genuinely
     * press twice.
     */
    @Test
    fun `a save that changes nothing writes nothing and still reports success`() = runTest(testDispatcher) {
        val vm = loadedViewModel()

        vm.updateBusinessSettings(vm.uiState.value.businessSettings)
        advanceUntilIdle()

        coVerify(exactly = 0) { repo.updateBusinessSettingsFields(any(), any()) }
        assertTrue("nothing to save is the same outcome as saved", vm.uiState.value.saveSuccess)
    }

    /**
     * The baseline moves to what the server now holds. Without this a second save
     * re-sends the first save's fields, which is the same clobber one step later.
     */
    @Test
    fun `a second save does not re-send the first save's field`() = runTest(testDispatcher) {
        val vm = loadedViewModel()
        vm.updateBusinessSettings(vm.uiState.value.businessSettings.copy(venmoHandle = "@new-venmo"))
        advanceUntilIdle()

        val changes = captureChanges()
        vm.updateBusinessSettings(vm.uiState.value.businessSettings.copy(weatherLocation = "Dallas, TX"))
        advanceUntilIdle()

        assertEquals(mapOf<String, Any?>("weatherLocation" to "Dallas, TX"), changes.captured)
    }

    /** A rejected write must leave the baseline where it was, so a retry re-sends the edit. */
    @Test
    fun `a failed save keeps the edit pending for the retry`() = runTest(testDispatcher) {
        coEvery { repo.updateBusinessSettingsFields(any(), any()) } returns
            Result.failure(RuntimeException("permission denied"))
        val vm = loadedViewModel()

        vm.updateBusinessSettings(vm.uiState.value.businessSettings.copy(venmoHandle = "@new-venmo"))
        advanceUntilIdle()
        assertNotNull(vm.uiState.value.error)

        val changes = captureChanges()
        vm.updateBusinessSettings(vm.uiState.value.businessSettings)
        advanceUntilIdle()
        assertEquals(mapOf<String, Any?>("venmoHandle" to "@new-venmo"), changes.captured)
    }

    /**
     * A save before a successful load has no baseline to diff against, and the
     * screen starts on `BusinessSettings()` - all defaults. Writing that model
     * would blank the business name, the handles and the calendar id in one go.
     * Refuse loudly instead, the rule `DirectoryViewModel.saveKinfolkChanges`
     * already follows.
     */
    @Test
    fun `a save before the settings ever loaded is refused, not written`() = runTest(testDispatcher) {
        coEvery { repo.getBusinessSettings() } returns Result.failure(RuntimeException("offline"))
        val vm = AdminSettingsViewModel(repository = repo)
        vm.loadBusinessSettings()
        advanceUntilIdle()

        vm.updateBusinessSettings(BusinessSettings(venmoHandle = "@new-venmo"))
        advanceUntilIdle()

        coVerify(exactly = 0) { repo.updateBusinessSettingsFields(any(), any()) }
        assertFalse(vm.uiState.value.saveSuccess)
        assertNotNull("a refused save must say so", vm.uiState.value.error)
    }
}

/** The Service Management screen's slice of the same document. */
@OptIn(ExperimentalCoroutinesApi::class)
class ServiceManagementSettingsSaveTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var serviceRepo: ServiceRepository
    private lateinit var auntieRepo: AuntieRepository

    private val stored = BusinessSettings(
        calendarSyncId = "old@group.calendar.google.com",
        travelBufferMinutes = 30,
    )

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
        coEvery { serviceRepo.getBusinessHours() } returns Result.success(emptyList())
        coEvery { auntieRepo.getBusinessSettings() } returns Result.success(stored)
        coEvery { auntieRepo.updateBusinessSettingsFields(any(), any()) } returns Result.success(Unit)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `a calendar id set on the web after the load is not reverted by an unrelated save`() =
        runTest(testDispatcher) {
            val changes = slot<Map<String, Any?>>()
            coEvery { auntieRepo.updateBusinessSettingsFields(capture(changes), any()) } returns
                Result.success(Unit)
            val vm = ServiceManagementViewModel(
                serviceRepository = serviceRepo,
                auntieRepository = auntieRepo,
            )
            advanceUntilIdle()

            vm.updateBusinessSettings(vm.state.value.businessSettings.copy(travelBufferMinutes = 45))
            advanceUntilIdle()

            assertEquals(mapOf<String, Any?>("travelBufferMinutes" to 45), changes.captured)
        }
}

/** The Scheduling screen's three writes into the same document. */
@OptIn(ExperimentalCoroutinesApi::class)
class SchedulingSettingsSaveTest {

    private val testDispatcher = UnconfinedTestDispatcher()

    private lateinit var bookingRepo: BookingRepository
    private lateinit var serviceRepo: ServiceRepository
    private lateinit var auntieRepo: AuntieRepository
    private lateinit var kinCareRepo: KinCareRepository

    private val stored = BusinessSettings(
        venmoHandle = "@old-venmo",
        calendarSyncId = "old@group.calendar.google.com",
        defaultBookingMode = "SPECIFIC_TIME",
        travelBufferMinutes = 30,
    )

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
        coEvery { auntieRepo.getBusinessSettings() } returns Result.success(stored)
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
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun captureChanges(): CapturingSlot<Map<String, Any?>> {
        val changes = slot<Map<String, Any?>>()
        coEvery { auntieRepo.updateBusinessSettingsFields(capture(changes), any()) } returns
            Result.success(Unit)
        return changes
    }

    private fun buildViewModel(): EnhancedSchedulingViewModel = EnhancedSchedulingViewModel(
        bookingRepository = bookingRepo,
        serviceRepository = serviceRepo,
        auntieRepository = auntieRepo,
        kinCareRepository = kinCareRepo,
    )

    /**
     * The calendar id is the field a web operator is MOST likely to be editing at
     * the same time - it is the one setting the React admin's Calendar section
     * exists to hold - and switching the phone's calendar view used to rewrite it.
     */
    @Test
    fun `changing the booking mode does not revert a calendar id set on the web`() =
        runTest(testDispatcher) {
            val vm = buildViewModel()
            advanceUntilIdle()
            val changes = captureChanges()

            vm.changeBookingMode(com.tribetails.auntieos.data.model.BookingMode.TIME_BLOCK)
            advanceUntilIdle()

            assertEquals(mapOf<String, Any?>("defaultBookingMode" to "TIME_BLOCK"), changes.captured)
        }

    @Test
    fun `saving the calendar id does not revert a payment handle set on the web`() =
        runTest(testDispatcher) {
            val vm = buildViewModel()
            advanceUntilIdle()
            val changes = captureChanges()

            vm.saveCalendarSyncId("new@group.calendar.google.com")
            advanceUntilIdle()

            assertEquals(
                mapOf<String, Any?>("calendarSyncId" to "new@group.calendar.google.com"),
                changes.captured,
            )
            assertTrue(vm.state.value.calendarSyncIdSaved)
        }

    /**
     * Re-saving the id the document already holds sends nothing, and must not
     * log an audit entry either. "Set Google Calendar sync id" against a save
     * that wrote no bytes is the same lie a moved `updatedAt` tells, one
     * collection over.
     */
    @Test
    fun `re-saving the calendar id the doc already holds writes nothing and audits nothing`() =
        runTest(testDispatcher) {
            val vm = buildViewModel()
            advanceUntilIdle()

            vm.saveCalendarSyncId("  old@group.calendar.google.com  ")
            advanceUntilIdle()

            coVerify(exactly = 0) { auntieRepo.updateBusinessSettingsFields(any(), any()) }
            coVerify(exactly = 0) { auntieRepo.logActivity(any()) }
            assertTrue("nothing to save is the same outcome as saved", vm.state.value.calendarSyncIdSaved)
        }

    @Test
    fun `the in-place settings updater writes only what its lambda changed`() =
        runTest(testDispatcher) {
            val vm = buildViewModel()
            advanceUntilIdle()
            val changes = captureChanges()

            vm.updateBusinessSettings { it.copy(travelBufferMinutes = 45) }
            advanceUntilIdle()

            assertEquals(mapOf<String, Any?>("travelBufferMinutes" to 45), changes.captured)
        }

    /**
     * This screen falls back to `BusinessSettings()` when the settings read fails,
     * so before the fix a save after a failed load wrote a near-DEFAULT document
     * over the real one: business name blanked, handles blanked, calendar id
     * blanked. With no baseline there is nothing to diff against, so refuse.
     */
    @Test
    fun `a save after a failed settings load writes nothing`() = runTest(testDispatcher) {
        coEvery { auntieRepo.getBusinessSettings() } returns Result.failure(RuntimeException("offline"))
        val vm = buildViewModel()
        advanceUntilIdle()

        vm.updateBusinessSettings { it.copy(travelBufferMinutes = 45) }
        vm.changeBookingMode(com.tribetails.auntieos.data.model.BookingMode.TIME_BLOCK)
        vm.saveCalendarSyncId("new@group.calendar.google.com")
        advanceUntilIdle()

        coVerify(exactly = 0) { auntieRepo.updateBusinessSettingsFields(any(), any()) }
        assertNotNull("a refused save must say so", vm.state.value.errorMessage)
    }

    /** The vocabularies live on this doc too, and no scheduling write may touch them. */
    @Test
    fun `a scheduling save never names a tag vocabulary`() = runTest(testDispatcher) {
        val vocab = listOf(
            TagDef(name = "VIP", color = TagColor(token = "accent", css = "var(--color-accent)"), icon = "*"),
        )
        coEvery { auntieRepo.getBusinessSettings() } returns
            Result.success(stored.copy(householdTags = encodeTagDefs(vocab)))
        val vm = buildViewModel()
        advanceUntilIdle()
        val changes = captureChanges()

        vm.updateBusinessSettings { it.copy(travelBufferMinutes = 45) }
        advanceUntilIdle()

        assertFalse(
            "a scheduling save must not carry the tag vocabularies: ${changes.captured}",
            changes.captured.containsKey("householdTags") || changes.captured.containsKey("petTags"),
        )
    }

    /** A re-encoded EMPTY vocabulary must not be written over "never configured" either. */
    @Test
    fun `a scheduling save leaves an absent pet vocabulary absent`() = runTest(testDispatcher) {
        val vm = buildViewModel()
        advanceUntilIdle()
        val changes = captureChanges()

        vm.updateBusinessSettings { it.withPetTagDefs(it.petTagDefs()).copy(travelBufferMinutes = 45) }
        advanceUntilIdle()

        assertEquals(mapOf<String, Any?>("travelBufferMinutes" to 45), changes.captured)
    }
}
