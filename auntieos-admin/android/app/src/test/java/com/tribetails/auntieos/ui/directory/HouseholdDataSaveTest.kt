package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.HouseholdData
import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.lang.reflect.Modifier

/**
 * The household save writes a DIFF, not the model it loaded.
 *
 * Android used to `.set(loadedModel.copy(updatedAt = now), merge())`. `merge()`
 * only protects fields OUTSIDE the written map; every one of the ~32 fields
 * INSIDE it was written back at whatever value the phone read minutes earlier,
 * so any edit made on the React admin between the load and the save was
 * silently reverted. That is the failure mode the web side already fixed and
 * documented (`auntieos-admin/src/api/householdData.ts:110-127`, citing the
 * 2026-07-20 `familyKinPath` data-loss incident).
 *
 * The concurrent-edit test below is the load-bearing one: a test that only
 * checks "the edited field was written" passes on the broken code too.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class HouseholdDataSaveTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        coEvery { repo.getDossier(any()) } returns Result.success(null)
        coEvery { repo.getVetClinicsOnce() } returns Result.success(emptyList())
        coEvery { repo.updateHouseholdFields(any(), any()) } returns Result.success(Unit)
        coEvery { repo.saveHouseholdData(any()) } returns Result.success(Unit)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    /** The record as it stood when the phone read it. */
    private val stored = HouseholdData(
        id = "hd1",
        kinfolkId = "kf1",
        primaryVetClinicId = "clinic_old",
        foodLocation = "pantry",
        householdRules = "shoes off",
    )

    private fun TestScope.loadedViewModel(record: HouseholdData): HouseholdDataViewModel {
        coEvery { repo.getHouseholdData(record.kinfolkId) } returns Result.success(record)
        val vm = HouseholdDataViewModel(repository = repo)
        vm.loadHouseholdData(record.kinfolkId)
        advanceUntilIdle()
        return vm
    }

    private fun captureChanges(): io.mockk.CapturingSlot<Map<String, String>> {
        val changes = slot<Map<String, String>>()
        coEvery { repo.updateHouseholdFields(any(), capture(changes)) } returns Result.success(Unit)
        return changes
    }

    @Test
    fun `a save writes only the field the operator edited`() = runTest(testDispatcher) {
        val changes = captureChanges()
        val vm = loadedViewModel(stored)

        vm.updateFoodLocation("garage shelf")
        vm.saveHouseholdData()
        advanceUntilIdle()

        assertEquals(mapOf("foodLocation" to "garage shelf"), changes.captured)
    }

    /**
     * THE CONCURRENT-EDIT CASE, and the reason this fix exists.
     *
     * An operator opens Household Data on the phone. While it sits there, someone
     * re-picks the household's vet in the React admin, so `primaryVetClinicId` is
     * now `clinic_new` on the server while the phone's copy still says
     * `clinic_old`. The operator then saves ONE unrelated field.
     *
     * The write must not mention `primaryVetClinicId` at all. Naming it, even at
     * the value the phone honestly read, reverts the web's vet re-pick, and the
     * vet is the number a sitter dials in an emergency.
     */
    @Test
    fun `a vet re-picked on the web after the load is not reverted by an unrelated save`() = runTest(testDispatcher) {
        val changes = captureChanges()
        val vm = loadedViewModel(stored)   // phone holds primaryVetClinicId = "clinic_old"

        vm.updateFoodLocation("garage shelf")
        vm.saveHouseholdData()
        advanceUntilIdle()

        // The whole-model write is the bug itself: every field it carries is a
        // field it reverts.
        coVerify(exactly = 0) { repo.saveHouseholdData(any()) }
        assertFalse(
            "the stale vet must not be in the written map: ${changes.captured}",
            changes.captured.containsKey("primaryVetClinicId"),
        )
        assertFalse(
            "no untouched field may be written: ${changes.captured}",
            changes.captured.containsKey("householdRules"),
        )
        assertEquals(setOf("foodLocation"), changes.captured.keys)
    }

    /**
     * The baseline moves to what was just written. Otherwise the second save
     * re-sends the first save's field, which is the same clobber one step later:
     * save A, web edits A, save B, and A is reverted.
     */
    @Test
    fun `a second save does not rewrite the first save's field`() = runTest(testDispatcher) {
        val changes = captureChanges()
        val vm = loadedViewModel(stored)

        vm.updateFoodLocation("garage shelf")
        vm.saveHouseholdData()
        advanceUntilIdle()

        vm.updateHouseholdRules("shoes off, gate closed")
        vm.saveHouseholdData()
        advanceUntilIdle()

        assertEquals(setOf("householdRules"), changes.captured.keys)
    }

    /** Nothing changed means nothing to write, and no stamp claiming otherwise. */
    @Test
    fun `saving an untouched record writes nothing`() = runTest(testDispatcher) {
        val vm = loadedViewModel(stored)

        vm.saveHouseholdData()
        advanceUntilIdle()

        coVerify(exactly = 0) { repo.updateHouseholdFields(any(), any()) }
        coVerify(exactly = 0) { repo.saveHouseholdData(any()) }
        assertTrue("the button must still settle", vm.uiState.value.isSuccess)
        assertFalse(vm.uiState.value.isSaving)
    }

    /**
     * The CREATE path still writes the whole document: there is no document yet,
     * so there is nothing to clobber, and a complete one keeps android's
     * `toObject(HouseholdData::class.java)` and the web reader happy. Same
     * reasoning as the web port's create branch.
     */
    @Test
    fun `a household with no record yet still writes the whole document`() = runTest(testDispatcher) {
        val written = slot<HouseholdData>()
        coEvery { repo.saveHouseholdData(capture(written)) } returns Result.success(Unit)
        coEvery { repo.getHouseholdData("kf9") } returns Result.success(null)

        val vm = HouseholdDataViewModel(repository = repo)
        vm.loadHouseholdData("kf9")
        advanceUntilIdle()
        vm.updateFoodLocation("pantry")
        vm.saveHouseholdData()
        advanceUntilIdle()

        assertEquals("kf9", written.captured.kinfolkId)
        assertEquals("pantry", written.captured.foodLocation)
        coVerify(exactly = 0) { repo.updateHouseholdFields(any(), any()) }
    }

    @Test
    fun `a failed save leaves the baseline alone so the edit is retried`() = runTest(testDispatcher) {
        coEvery { repo.updateHouseholdFields(any(), any()) } returns Result.failure(RuntimeException("offline"))
        val vm = loadedViewModel(stored)

        vm.updateFoodLocation("garage shelf")
        vm.saveHouseholdData()
        advanceUntilIdle()
        assertTrue(vm.uiState.value.error != null)

        val changes = captureChanges()
        vm.saveHouseholdData()
        advanceUntilIdle()
        assertEquals(mapOf("foodLocation" to "garage shelf"), changes.captured)
    }
}

/** The differ itself, away from the ViewModel. */
class HouseholdFieldChangesTest {

    private val loaded = HouseholdData(
        id = "hd1",
        kinfolkId = "kf1",
        primaryVetClinicId = "clinic_old",
        foodLocation = "pantry",
        createdAt = "2026-01-01T00:00:00Z",
        updatedAt = "2026-01-01T00:00:00Z",
    )

    @Test
    fun `an unchanged record diffs to nothing`() {
        assertEquals(emptyMap<String, String>(), householdFieldChanges(loaded, loaded.copy()))
    }

    @Test
    fun `only the changed field appears`() {
        val changes = householdFieldChanges(loaded, loaded.copy(foodLocation = "garage"))
        assertEquals(mapOf("foodLocation" to "garage"), changes)
    }

    /** Clearing a field is an edit, not a no-op: the blank must be written. */
    @Test
    fun `a field cleared to blank is written as blank`() {
        val changes = householdFieldChanges(loaded, loaded.copy(foodLocation = ""))
        assertEquals(mapOf("foodLocation" to ""), changes)
    }

    /** The stamps and the identity fields are the repository's business, never the diff's. */
    @Test
    fun `timestamps and identity never enter the diff`() {
        val changes = householdFieldChanges(
            loaded,
            loaded.copy(createdAt = "later", updatedAt = "later", kinfolkId = "kf2"),
        )
        assertEquals(emptyMap<String, String>(), changes)
    }

    /**
     * DRIFT GUARD. A hand-written field list silently stops saving any field
     * added to `HouseholdData` later, which would be a new quiet data-loss mode
     * introduced by the fix itself. Every mutable String on the model except the
     * identity and stamp fields must be diffed.
     */
    @Test
    fun `every model field is covered by the differ`() {
        val exempt = setOf("id", "kinfolkId", "createdAt", "updatedAt")
        val modelled = HouseholdData::class.java.declaredFields
            .filter { !Modifier.isStatic(it.modifiers) && it.type == String::class.java }
            .map { it.name }
            .filterNot { it in exempt }
            .toSet()

        assertEquals(
            "HouseholdData gained or lost a field; update HOUSEHOLD_DIFF_FIELDS",
            modelled,
            HOUSEHOLD_DIFF_FIELDS.keys,
        )
    }
}
