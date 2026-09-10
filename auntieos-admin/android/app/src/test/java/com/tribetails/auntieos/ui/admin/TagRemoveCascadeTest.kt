package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.TagDef
import com.tribetails.auntieos.data.model.TagScope
import com.tribetails.auntieos.data.model.encodeTagDefs
import com.tribetails.auntieos.data.model.paletteColor
import com.tribetails.auntieos.data.repository.AuntieRepository
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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #713: "IF THE TAG IS DELETED THEN IT GOES AWAY COMPLETELY."
 *
 * Removing a tag stopped being a local list edit saved with the rest of
 * settings. It now goes through the admin-gated `removeBusinessTag` callable,
 * which drops the vocabulary row AND strips the name off every kinfolk (or kin)
 * doc carrying it. These cover the view-model half of that and the pure copy
 * helpers the confirm and the report are built from.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class TagRemoveCascadeTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun def(name: String, token: String = "teal") =
        TagDef(name = name, color = paletteColor(token), icon = "")

    private fun settings(
        household: List<TagDef> = emptyList(),
        pet: List<TagDef> = emptyList(),
    ) = BusinessSettings(
        householdTags = encodeTagDefs(household),
        petTags = encodeTagDefs(pet),
    )

    private suspend fun loadedViewModel(settings: BusinessSettings): AdminSettingsViewModel {
        coEvery { mockRepo.getBusinessSettings() } returns Result.success(settings)
        val vm = AdminSettingsViewModel(repository = mockRepo)
        vm.loadBusinessSettings()
        return vm
    }

    // ── The view-model action ───────────────────────────────────────────────

    @Test
    fun `sends the scope wire value and the name, then drops the row and reports the count`() =
        runTest(testDispatcher) {
            val vm = loadedViewModel(settings(household = listOf(def("VIP"), def("Slow pay"))))
            coEvery { mockRepo.removeBusinessTag("household", "VIP") } returns Result.success(3)

            vm.removeBusinessTag(TagScope.HOUSEHOLD, "VIP")
            advanceUntilIdle()

            coVerify(exactly = 1) { mockRepo.removeBusinessTag("household", "VIP") }
            val state = vm.uiState.value
            assertEquals(
                listOf("Slow pay"),
                tagVocabFor(state.businessSettings, TagScope.HOUSEHOLD).map { it.name },
            )
            assertEquals("\"VIP\" is gone. It came off 3 households.", state.tagRemoveMessage)
            assertNull(state.tagRemoveError)
            assertEquals(false, state.tagRemoveBusy)
        }

    @Test
    fun `a pet-scope remove leaves a household tag of the same name alone`() =
        runTest(testDispatcher) {
            val vm = loadedViewModel(
                settings(household = listOf(def("Meds Needed")), pet = listOf(def("Meds Needed"))),
            )
            coEvery { mockRepo.removeBusinessTag("pet", "Meds Needed") } returns Result.success(1)

            vm.removeBusinessTag(TagScope.PET, "Meds Needed")
            advanceUntilIdle()

            val next = vm.uiState.value.businessSettings
            assertTrue(tagVocabFor(next, TagScope.PET).isEmpty())
            assertEquals(
                listOf("Meds Needed"),
                tagVocabFor(next, TagScope.HOUSEHOLD).map { it.name },
            )
        }

    @Test
    fun `a failed remove is fail-loud and leaves the row on the list to retry`() =
        runTest(testDispatcher) {
            val vm = loadedViewModel(settings(household = listOf(def("VIP"))))
            coEvery { mockRepo.removeBusinessTag(any(), any()) } returns
                Result.failure(RuntimeException("permission-denied"))

            vm.removeBusinessTag(TagScope.HOUSEHOLD, "VIP")
            advanceUntilIdle()

            val state = vm.uiState.value
            assertNotNull(state.tagRemoveError)
            assertTrue(state.tagRemoveError!!.contains("permission-denied"))
            assertNull(state.tagRemoveMessage)
            assertEquals(
                listOf("VIP"),
                tagVocabFor(state.businessSettings, TagScope.HOUSEHOLD).map { it.name },
            )
        }

    /**
     * The baseline has to move with the on-screen settings. If it did not, the
     * next diffed save would re-send the deleted vocabulary row and put the tag
     * straight back on the list.
     */
    @Test
    fun `a later save does not resurrect the deleted row`() = runTest(testDispatcher) {
        val vm = loadedViewModel(settings(household = listOf(def("VIP"), def("Slow pay"))))
        coEvery { mockRepo.removeBusinessTag("household", "VIP") } returns Result.success(0)
        coEvery { mockRepo.updateBusinessSettingsFields(any(), any()) } returns Result.success(Unit)

        vm.removeBusinessTag(TagScope.HOUSEHOLD, "VIP")
        advanceUntilIdle()

        // Save an unrelated field. The tag lists are unchanged against the moved
        // baseline, so no householdTags write goes out at all.
        vm.updateBusinessSettings(vm.uiState.value.businessSettings.copy(businessName = "Tribetails"))
        advanceUntilIdle()

        coVerify {
            mockRepo.updateBusinessSettingsFields(
                match { fields -> !fields.containsKey("householdTags") },
                any(),
            )
        }
    }

    @Test
    fun `clearTagRemoveFeedback puts both banners away`() = runTest(testDispatcher) {
        val vm = loadedViewModel(settings(household = listOf(def("VIP"))))
        coEvery { mockRepo.removeBusinessTag(any(), any()) } returns Result.success(2)

        vm.removeBusinessTag(TagScope.HOUSEHOLD, "VIP")
        advanceUntilIdle()
        assertNotNull(vm.uiState.value.tagRemoveMessage)

        vm.clearTagRemoveFeedback()
        assertNull(vm.uiState.value.tagRemoveMessage)
        assertNull(vm.uiState.value.tagRemoveError)
    }

    // ── Pure copy helpers ───────────────────────────────────────────────────

    @Test
    fun `withTagRemoved edits only the named scope, case-insensitively`() {
        val s = settings(household = listOf(def("VIP")), pet = listOf(def("VIP")))
        val next = withTagRemoved(s, TagScope.HOUSEHOLD, "  vip ")
        assertTrue(tagVocabFor(next, TagScope.HOUSEHOLD).isEmpty())
        assertEquals(listOf("VIP"), tagVocabFor(next, TagScope.PET).map { it.name })
    }

    /** The count is the server's; the sentence must stay honest at 0 and at 1. */
    @Test
    fun `the report names the count and pluralizes it`() {
        assertEquals(
            "\"VIP\" is gone. No households were carrying it.",
            tagRemovedSummary(TagScope.HOUSEHOLD, "VIP", 0),
        )
        assertEquals(
            "\"VIP\" is gone. It came off 1 household.",
            tagRemovedSummary(TagScope.HOUSEHOLD, "VIP", 1),
        )
        assertEquals(
            "\"VIP\" is gone. It came off 4 households.",
            tagRemovedSummary(TagScope.HOUSEHOLD, "VIP", 4),
        )
        // "Kin" is both singular and plural, so the pet copy must not say "Kins".
        assertEquals(
            "\"Reactive\" is gone. It came off 2 Kin.",
            tagRemovedSummary(TagScope.PET, "Reactive", 2),
        )
    }

    /** The confirm has to say the cascade out loud, not just "remove tag". */
    @Test
    fun `the confirm states what else the delete touches`() {
        val household = tagRemoveConfirmBody(TagScope.HOUSEHOLD, "VIP")
        assertTrue(household.contains("off every household carrying it"))
        assertTrue(household.contains("cannot be undone"))
        val pet = tagRemoveConfirmBody(TagScope.PET, "Reactive")
        assertTrue(pet.contains("off every Kin carrying it"))
    }
}
