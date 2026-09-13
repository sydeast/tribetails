package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.ContactOverride
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import io.mockk.CapturingSlot
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
 * The household (`kinfolk`) and pet (`kin`) saves write a DIFF, not the model
 * they loaded, and not a model rebuilt out of form state.
 *
 * Two bugs meet on these two paths. The whole-model `.set(model, merge())`
 * reverted anything changed between the load and the save, because merge only
 * protects fields OUTSIDE the written map. And the edit screens rebuilt the
 * model FROM SCRATCH, so any field the form did not carry was written at its
 * Kotlin default: `Kinfolk.uid` (the MyTribe login linkage) blanked,
 * `Kin.tags` nulled, `Kin.status` forced back to "active".
 *
 * The concurrent-edit tests below are the load-bearing ones: a test that only
 * checks "the edited field was written" passes on the broken code too.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DirectorySaveTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private val repo = mockk<AuntieRepository>(relaxed = true)
    private val invoiceRepo = mockk<InvoiceRepository>(relaxed = true)
    private val kinCareRepo = mockk<KinCareRepository>(relaxed = true)

    /** The household as it stood when the phone read it. */
    private val storedKinfolk = Kinfolk(
        id = "kf1",
        firstName = "Ada",
        lastName = "Lovelace",
        phoneNumber = "5551234567",
        email = "ada@example.com",
        internalNotes = "gate sticks",
        preferredContactMethod = "Text",
        bestTimeToContact = "mornings",
        uid = "auth-uid-9",
        contactOverride = ContactOverride(channel = "email", note = "travelling"),
        archivedAt = "2026-01-05T00:00:00Z",
        archivedReason = "moved away",
        archivedBy = "auntie",
        tags = listOf("vip"),
    )

    /** The pet as it stood when the phone read it. */
    private val storedKin = Kin(
        id = "k1",
        kinfolkId = "kf1",
        name = "Byron",
        breed = "Corgi",
        status = "archived",
        medicationHealthNotes = "half a tablet at 8am",
        familyKinPath = "families/kf1/kin/k1",
        tags = listOf("senior"),
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        coEvery { repo.getKinfolk() } returns Result.success(listOf(storedKinfolk))
        coEvery { repo.getAllKin() } returns Result.success(listOf(storedKin))
        coEvery { repo.getKin(any()) } returns Result.success(listOf(storedKin))
        coEvery { repo.getDossier(any()) } returns Result.success(null)
        coEvery { repo.get411ForKin(any()) } returns Result.failure(NoSuchElementException("none"))
        coEvery { repo.listFormSchemas() } returns Result.success(emptyList())
        coEvery { repo.getHouseholdData(any()) } returns Result.success(null)
        coEvery { repo.getVetClinicsOnce() } returns Result.success(emptyList())
        coEvery { repo.logActivity(any()) } returns Result.success(Unit)
        coEvery { kinCareRepo.getKinCareSessions() } returns Result.success(emptyList())
        coEvery { kinCareRepo.getAllKinCareReports() } returns Result.success(emptyList())
        coEvery { kinCareRepo.getKinCareSessionsForKinfolk(any()) } returns Result.success(emptyList())
        coEvery { invoiceRepo.getInvoicesForKinfolk(any()) } returns Result.success(emptyList())
        coEvery { repo.updateKinfolkFields(any(), any()) } returns Result.success(Unit)
        coEvery { repo.updateKinFields(any(), any(), any()) } returns Result.success(Unit)
        // The cold-arrival reads: the by-id pet fetch the editor falls back to
        // when no household profile has been opened, and the owner behind it.
        coEvery { repo.getKinByIds(any()) } returns Result.success(mapOf(storedKin.id to storedKin))
        coEvery { repo.getKinfolkById(any()) } returns Result.success(storedKinfolk)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun captureKinfolkChanges(): CapturingSlot<Map<String, Any>> {
        val changes = slot<Map<String, Any>>()
        coEvery { repo.updateKinfolkFields(any(), capture(changes)) } returns Result.success(Unit)
        return changes
    }

    private fun captureKinChanges(): CapturingSlot<Map<String, Any>> {
        val changes = slot<Map<String, Any>>()
        coEvery { repo.updateKinFields(any(), any(), capture(changes)) } returns Result.success(Unit)
        return changes
    }

    private fun TestScope.viewModel(): DirectoryViewModel {
        val vm = DirectoryViewModel(repo, invoiceRepo, kinCareRepo)
        advanceUntilIdle()
        return vm
    }

    private fun TestScope.kinfolkEditor(): DirectoryViewModel {
        val vm = viewModel()
        vm.loadKinfolkForEdit(storedKinfolk.id)
        advanceUntilIdle()
        return vm
    }

    private fun TestScope.kinEditor(): DirectoryViewModel {
        val vm = viewModel()
        vm.loadProfile(storedKin.kinfolkId)
        advanceUntilIdle()
        vm.loadKinForEdit(storedKin.id)
        advanceUntilIdle()
        return vm
    }

    /**
     * The editor opened with NO household profile behind it, which is how the
     * Kin detail screen's "Edit kin" and any deep link reach it.
     */
    private fun TestScope.coldKinEditor(): DirectoryViewModel {
        val vm = viewModel()
        vm.loadKinForEdit(storedKin.id)
        advanceUntilIdle()
        return vm
    }

    // ── kinfolk ──────────────────────────────────────────────────────────────

    @Test
    fun `a household save writes only the field the operator edited`() = runTest(testDispatcher) {
        val changes = captureKinfolkChanges()
        val vm = kinfolkEditor()

        vm.updateEditInternalNotes("gate sticks, lift and push")
        vm.saveKinfolkChanges()
        advanceUntilIdle()

        assertEquals(setOf("internalNotes"), changes.captured.keys)
        assertEquals("gate sticks, lift and push", changes.captured["internalNotes"])
    }

    /**
     * THE CONCURRENT-EDIT CASE for `kinfolk`, and the reason this fix exists.
     *
     * `firestore.rules#onlyAllowedKinfolkFields` lets a KINFOLK edit their own
     * `preferredContactMethod` and `bestTimeToContact` from the MyTribe portal.
     * An operator opens the household on the phone; the kinfolk then switches
     * themselves to "Phone" in the portal. The operator saves one unrelated
     * field.
     *
     * The write must not mention either field. Naming them, even at the value
     * the phone honestly read, reverts the kinfolk's own choice about how their
     * household gets contacted - the exact loss
     * `auntieos-admin/src/api/kinfolkProfileWrite.ts` refuses to risk by never
     * naming them at all.
     */
    @Test
    fun `a kinfolk's own portal contact edit is not reverted by an unrelated save`() = runTest(testDispatcher) {
        val changes = captureKinfolkChanges()
        val vm = kinfolkEditor()   // phone holds preferredContactMethod = "Text"

        vm.updateEditInternalNotes("gate sticks, lift and push")
        vm.saveKinfolkChanges()
        advanceUntilIdle()

        assertFalse(
            "the stale contact method must not be written: ${changes.captured}",
            changes.captured.containsKey("preferredContactMethod"),
        )
        assertFalse(
            "the stale contact window must not be written: ${changes.captured}",
            changes.captured.containsKey("bestTimeToContact"),
        )
        assertEquals(setOf("internalNotes"), changes.captured.keys)
    }

    /**
     * The from-scratch rebuild wrote KOTLIN DEFAULTS over four server-owned
     * fields on every ordinary edit. `uid` is the worst of them: blanking it
     * unlinks the household from its MyTribe login, and nothing reports it.
     */
    @Test
    fun `a household save never blanks the portal linkage, override or archive trail`() = runTest(testDispatcher) {
        val changes = captureKinfolkChanges()
        val vm = kinfolkEditor()

        vm.updateEditInternalNotes("gate sticks, lift and push")
        vm.saveKinfolkChanges()
        advanceUntilIdle()

        for (serverOwned in listOf("uid", "contactOverride", "archivedAt", "archivedReason", "archivedBy")) {
            assertFalse(
                "$serverOwned belongs to the server, not this editor: ${changes.captured}",
                changes.captured.containsKey(serverOwned),
            )
        }
    }

    /** Nothing changed means nothing written, and no stamp claiming otherwise. */
    @Test
    fun `saving an untouched household writes nothing`() = runTest(testDispatcher) {
        val vm = kinfolkEditor()

        vm.saveKinfolkChanges()
        advanceUntilIdle()

        coVerify(exactly = 0) { repo.updateKinfolkFields(any(), any()) }
        assertTrue("the button must still settle", vm.editKinfolkState.value.isSuccess)
        assertFalse(vm.editKinfolkState.value.isSaving)
    }

    /**
     * The baseline moves to what was just written. Otherwise the second save
     * re-sends the first save's field, which is the same clobber one step later.
     */
    @Test
    fun `a second household save does not rewrite the first save's field`() = runTest(testDispatcher) {
        val changes = captureKinfolkChanges()
        val vm = kinfolkEditor()

        vm.updateEditInternalNotes("gate sticks, lift and push")
        vm.saveKinfolkChanges()
        advanceUntilIdle()

        vm.updateEditGateCode("2468")
        vm.saveKinfolkChanges()
        advanceUntilIdle()

        assertEquals(setOf("gateCode"), changes.captured.keys)
    }

    /** A failed save keeps the edit pending instead of swallowing it. */
    @Test
    fun `a failed household save leaves the baseline alone so the edit is retried`() = runTest(testDispatcher) {
        coEvery { repo.updateKinfolkFields(any(), any()) } returns Result.failure(RuntimeException("offline"))
        val vm = kinfolkEditor()

        vm.updateEditInternalNotes("gate sticks, lift and push")
        vm.saveKinfolkChanges()
        advanceUntilIdle()
        assertTrue(vm.editKinfolkState.value.error != null)

        val changes = captureKinfolkChanges()
        vm.saveKinfolkChanges()
        advanceUntilIdle()

        assertEquals(setOf("internalNotes"), changes.captured.keys)
    }

    // ── kin ──────────────────────────────────────────────────────────────────

    /**
     * THE CONCURRENT-EDIT CASE for `kin`. The React admin patches this
     * collection field-level (`api/directoryWrite.ts#updateKin`), so an operator
     * saving a pet on the phone must not send back the medication note the web
     * corrected while the phone sat open. This is the field a sitter doses off.
     */
    @Test
    fun `a medication note corrected on the web is not reverted by an unrelated pet save`() = runTest(testDispatcher) {
        val changes = captureKinChanges()
        val vm = kinEditor()

        vm.updateEditKinBreed("Pembroke Corgi")
        vm.saveKinChanges()
        advanceUntilIdle()

        assertFalse(
            "the stale medication note must not be written: ${changes.captured}",
            changes.captured.containsKey("medicationHealthNotes"),
        )
        assertEquals(setOf("breed"), changes.captured.keys)
    }

    /**
     * The pet rebuild was destructive, not merely stale. `Kin.tags` exists on
     * the model precisely so android saves would stop wiping React's pet tags -
     * but the builder never populated it, so every save still sent null. It also
     * hardcoded `status = "active"`, which un-archives an archived pet.
     *
     * `ownerEmail` / `ownerPhone` used to be on this list too: #687 retired both
     * from `Kin` entirely (no editor anywhere ever wrote them), so there is no
     * longer a field for a save to wipe or preserve.
     */
    @Test
    fun `a pet save never wipes tags, photos, or the archived status`() = runTest(testDispatcher) {
        val changes = captureKinChanges()
        val vm = kinEditor()

        vm.updateEditKinBreed("Pembroke Corgi")
        vm.saveKinChanges()
        advanceUntilIdle()

        for (untouched in listOf("tags", "photos", "status")) {
            assertFalse(
                "$untouched was not edited and must not be written: ${changes.captured}",
                changes.captured.containsKey(untouched),
            )
        }
    }

    /** The mirror FK is derived, so it is re-stamped on every save, never diffed. */
    @Test
    fun `a pet save re-stamps the mirror FK and never diffs it`() = runTest(testDispatcher) {
        val changes = captureKinChanges()
        val vm = kinEditor()

        vm.updateEditKinBreed("Pembroke Corgi")
        vm.saveKinChanges()
        advanceUntilIdle()

        coVerify(exactly = 1) { repo.updateKinFields("k1", "kf1", any()) }
        assertFalse(changes.captured.containsKey("familyKinPath"))
    }

    @Test
    fun `saving an untouched pet writes nothing`() = runTest(testDispatcher) {
        val vm = kinEditor()

        vm.saveKinChanges()
        advanceUntilIdle()

        coVerify(exactly = 0) { repo.updateKinFields(any(), any(), any()) }
        assertTrue(vm.editKinState.value.isSuccess)
    }

    // ── cold arrival ─────────────────────────────────────────────────────────

    /**
     * The editor used to resolve its pet out of `profileState.kinList`, which
     * only `loadProfile` fills, so opened any other way it reported "Kin not
     * found". The deeper cost was the BASELINE: `loadedKin` is what
     * `saveKinChanges` diffs against, and with no baseline there is nothing to
     * save at all. The Kin detail screen's "Edit kin" is exactly that arrival.
     */
    @Test
    fun `a pet opened with no profile behind it still loads`() = runTest(testDispatcher) {
        val vm = coldKinEditor()

        assertEquals("Byron", vm.editKinState.value.name)
        assertEquals(null, vm.editKinState.value.error)
    }

    @Test
    fun `a pet opened with no profile behind it still saves only the edited field`() = runTest(testDispatcher) {
        val changes = captureKinChanges()
        val vm = coldKinEditor()

        vm.updateEditKinBreed("Pembroke Corgi")
        vm.saveKinChanges()
        advanceUntilIdle()

        assertEquals(setOf("breed"), changes.captured.keys)
    }

    // ── archive / restore ────────────────────────────────────────────────────

    /**
     * `kin.status` is editable on the React admin and, until the Kin detail
     * build gave the editor this control, on no Android surface at all. It
     * writes ONE field: an archive must not carry a stale medication note out
     * with it, and a later Save must not be able to un-archive the pet.
     */
    @Test
    fun `restoring a pet writes only its status`() = runTest(testDispatcher) {
        val changes = captureKinChanges()
        val vm = kinEditor()

        vm.setKinArchived(false)
        advanceUntilIdle()

        assertEquals(mapOf<String, Any>("status" to "active"), changes.captured)
    }

    @Test
    fun `archiving a pet writes only its status`() = runTest(testDispatcher) {
        coEvery { repo.getKin(any()) } returns Result.success(listOf(storedKin.copy(status = "active")))
        val changes = captureKinChanges()
        val vm = kinEditor()

        vm.setKinArchived(true)
        advanceUntilIdle()

        assertEquals(mapOf<String, Any>("status" to "archived"), changes.captured)
    }

    /** Already in the state being asked for: nothing written, no stamp moved. */
    @Test
    fun `archiving an already archived pet writes nothing`() = runTest(testDispatcher) {
        val vm = kinEditor()

        vm.setKinArchived(true)
        advanceUntilIdle()

        coVerify(exactly = 0) { repo.updateKinFields(any(), any(), any()) }
    }

    /**
     * A rejected status write keeps the operator's pending edit and SAYS SO,
     * rather than closing the screen on a change that never landed.
     */
    @Test
    fun `a failed archive keeps the form open and reports the failure`() = runTest(testDispatcher) {
        coEvery { repo.updateKinFields(any(), any(), any()) } returns Result.failure(RuntimeException("offline"))
        val vm = kinEditor()

        vm.updateEditKinBreed("Pembroke Corgi")
        vm.setKinArchived(false)
        advanceUntilIdle()

        val state = vm.editKinState.value
        assertFalse("a rejected write must not report success", state.isSuccess)
        assertEquals("offline", state.error)
        assertEquals("Pembroke Corgi", state.breed)
    }
}

/** The differs themselves, away from the ViewModel. */
class DirectoryFieldChangesTest {

    private val kinfolk = Kinfolk(
        id = "kf1",
        firstName = "Ada",
        internalNotes = "gate sticks",
        uid = "auth-uid-9",
        tags = listOf("vip"),
    )

    private val kin = Kin(id = "k1", kinfolkId = "kf1", name = "Byron", tags = listOf("senior"))

    @Test
    fun `an unchanged kinfolk diffs to nothing`() {
        assertEquals(emptyMap<String, Any>(), kinfolkFieldChanges(kinfolk, kinfolk.copy()))
    }

    @Test
    fun `an unchanged kin diffs to nothing`() {
        assertEquals(emptyMap<String, Any>(), kinFieldChanges(kin, kin.copy()))
    }

    @Test
    fun `only the changed kinfolk field appears`() {
        assertEquals(
            mapOf("firstName" to "Augusta"),
            kinfolkFieldChanges(kinfolk, kinfolk.copy(firstName = "Augusta")),
        )
    }

    /** Clearing a field is an edit, not a no-op: the blank must be written. */
    @Test
    fun `a kinfolk field cleared to blank is written as blank`() {
        assertEquals(
            mapOf("internalNotes" to ""),
            kinfolkFieldChanges(kinfolk, kinfolk.copy(internalNotes = "")),
        )
    }

    /**
     * A doc predating the Tags feature carries no `tags` key at all and decodes
     * to null, while the editor hands back an empty list. Diffing the RAW value
     * would call that a change and write `[]` over a field nobody touched.
     */
    @Test
    fun `an absent tag list does not diff against an empty one`() {
        val untagged = kinfolk.copy(tags = null)
        assertEquals(emptyMap<String, Any>(), kinfolkFieldChanges(untagged, untagged.copy(tags = emptyList<String>())))
    }

    @Test
    fun `a retagged household writes the names`() {
        assertEquals(
            mapOf("tags" to listOf("vip", "winter")),
            kinfolkFieldChanges(kinfolk, kinfolk.copy(tags = listOf("vip", "winter"))),
        )
    }

    /** The stamp and the server-owned fields are never the diff's business. */
    @Test
    fun `the stamp and the portal linkage never enter the kinfolk diff`() {
        val changes = kinfolkFieldChanges(
            kinfolk,
            kinfolk.copy(updatedAt = "later", uid = "", contactOverride = null, archivedBy = ""),
        )
        assertEquals(emptyMap<String, Any>(), changes)
    }

    @Test
    fun `the derived mirror FK never enters the kin diff`() {
        assertEquals(
            emptyMap<String, Any>(),
            kinFieldChanges(kin, kin.copy(familyKinPath = "families/kf2/kin/k1", updatedAt = "later")),
        )
    }

    /**
     * DRIFT GUARD. A hand-written field list silently stops saving any field
     * added to the model later, which would be a new quiet data-loss mode
     * introduced by the fix itself. Every declared field must be either diffed
     * or explicitly named as somebody else's to write.
     */
    @Test
    fun `every kinfolk field is either diffed or declared server-owned`() {
        assertEquals(
            "Kinfolk gained or lost a field; update KINFOLK_DIFF_FIELDS or KINFOLK_SERVER_OWNED",
            declaredFields(Kinfolk::class.java),
            KINFOLK_DIFF_FIELDS.keys + KINFOLK_SERVER_OWNED,
        )
    }

    @Test
    fun `every kin field is either diffed or declared server-owned`() {
        assertEquals(
            "Kin gained or lost a field; update KIN_DIFF_FIELDS or KIN_SERVER_OWNED",
            declaredFields(Kin::class.java),
            KIN_DIFF_FIELDS.keys + KIN_SERVER_OWNED,
        )
    }

    private fun declaredFields(type: Class<*>): Set<String> =
        type.declaredFields
            .filter { !Modifier.isStatic(it.modifiers) && !it.isSynthetic }
            .map { it.name }
            .toSet()
}
