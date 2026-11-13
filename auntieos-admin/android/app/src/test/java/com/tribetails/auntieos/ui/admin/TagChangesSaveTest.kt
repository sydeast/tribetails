package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.TagChange
import com.tribetails.auntieos.data.model.TagDef
import com.tribetails.auntieos.data.model.TagListsAfterChange
import com.tribetails.auntieos.data.model.TagScope
import com.tribetails.auntieos.data.model.encodeTagDefs
import com.tribetails.auntieos.data.model.paletteColor
import com.tribetails.auntieos.data.model.tagListChanges
import com.tribetails.auntieos.data.repository.AuntieRepository
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #2205: the Settings Tags panel's Save sends named changes (each new name, each
 * recolour) through `changeBusinessTags`, never the lists. The server applies
 * them to the lists as stored, so a tag added on another device is kept and one
 * deleted there is not brought back.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class TagChangesSaveTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private fun def(name: String, token: String = "teal", icon: String = "") =
        TagDef(name = name, color = paletteColor(token), icon = icon)

    private fun settings(household: List<TagDef> = emptyList(), pet: List<TagDef> = emptyList()) =
        BusinessSettings(businessName = "Tribe Tails", householdTags = encodeTagDefs(household), petTags = encodeTagDefs(pet))

    private fun loadedViewModel(settings: BusinessSettings): AdminSettingsViewModel {
        coEvery { repo.getBusinessSettings() } returns Result.success(settings)
        val vm = AdminSettingsViewModel(repository = repo)
        vm.loadBusinessSettings()
        return vm
    }

    @Test
    fun `Save sends only the named add, and never a settings save`() = runTest(testDispatcher) {
        val vm = loadedViewModel(settings(household = listOf(def("VIP"))))
        val sent = slot<List<TagChange>>()
        coEvery { repo.changeBusinessTags(capture(sent)) } returns
            Result.success(TagListsAfterChange(listOf(def("VIP"), def("Gate code")), emptyList()))

        vm.saveTagChanges(listOf(def("VIP"), def("Gate code")), emptyList())
        advanceUntilIdle()

        assertEquals(listOf(TagChange(TagChange.ADD, TagScope.HOUSEHOLD, "Gate code", paletteColor("teal"), "")), sent.captured)
        coVerify(exactly = 0) { repo.updateBusinessSettingsFields(any(), any()) }
        assertTrue(vm.uiState.value.tagSaved)
        assertNull(vm.uiState.value.tagSaveError)
    }

    @Test
    fun `a tag added elsewhere after the panel loaded is kept and shown once saved`() = runTest(testDispatcher) {
        val vm = loadedViewModel(settings(household = listOf(def("VIP"))))
        // The server's list carries "Slow pay", added on another device since this read.
        coEvery { repo.changeBusinessTags(any()) } returns
            Result.success(TagListsAfterChange(listOf(def("VIP"), def("Slow pay"), def("Gate code")), emptyList()))

        vm.saveTagChanges(listOf(def("VIP"), def("Gate code")), emptyList())
        advanceUntilIdle()

        assertEquals(
            listOf("VIP", "Slow pay", "Gate code"),
            tagVocabFor(vm.uiState.value.businessSettings, TagScope.HOUSEHOLD).map { it.name },
        )
    }

    @Test
    fun `after a save, a later settings save carries no tag list at all`() = runTest(testDispatcher) {
        val vm = loadedViewModel(settings(household = listOf(def("VIP"))))
        coEvery { repo.changeBusinessTags(any()) } returns
            Result.success(TagListsAfterChange(listOf(def("VIP"), def("Gate code")), emptyList()))
        val changes = slot<Map<String, Any?>>()
        coEvery { repo.updateBusinessSettingsFields(capture(changes), any()) } returns Result.success(Unit)

        vm.saveTagChanges(listOf(def("VIP"), def("Gate code")), emptyList())
        advanceUntilIdle()
        vm.updateBusinessSettings(vm.uiState.value.businessSettings.copy(businessName = "Tribetails"))
        advanceUntilIdle()

        assertEquals(setOf("businessName"), changes.captured.keys)
    }

    @Test
    fun `a refused save (a tag deleted elsewhere) says so and keeps the edit`() = runTest(testDispatcher) {
        val vm = loadedViewModel(settings(household = listOf(def("VIP"))))
        coEvery { repo.changeBusinessTags(any()) } returns Result.failure(
            RuntimeException("The tag list changed since this screen opened: \"VIP\" is no longer on it. Reload and try again."),
        )

        vm.saveTagChanges(listOf(def("VIP", token = "gold")), emptyList())
        advanceUntilIdle()

        val ui = vm.uiState.value
        assertEquals(
            "Couldn't save tags: The tag list changed since this screen opened: \"VIP\" is no longer on it. Reload and try again.",
            ui.tagSaveError,
        )
        assertFalse(ui.tagSaved)
        assertFalse(ui.tagSaveBusy)
        // Nothing moved locally: the stored copy is what was loaded.
        assertEquals(listOf(def("VIP")), tagVocabFor(ui.businessSettings, TagScope.HOUSEHOLD))
    }

    @Test
    fun `Reload tags re-reads only the two lists`() = runTest(testDispatcher) {
        val vm = loadedViewModel(settings(household = listOf(def("VIP"))))
        coEvery { repo.getBusinessSettings() } returns Result.success(settings(household = listOf(def("Slow pay"))))

        vm.reloadTagLists()
        advanceUntilIdle()

        assertEquals(listOf("Slow pay"), tagVocabFor(vm.uiState.value.businessSettings, TagScope.HOUSEHOLD).map { it.name })
        assertEquals("Tribe Tails", vm.uiState.value.businessSettings.businessName)
    }

    @Test
    fun `an untouched panel sends nothing`() = runTest(testDispatcher) {
        val vm = loadedViewModel(settings(household = listOf(def("VIP"))))
        vm.saveTagChanges(listOf(def("VIP")), emptyList())
        advanceUntilIdle()
        coVerify(exactly = 0) { repo.changeBusinessTags(any()) }
    }

    // ── The pure diff ──────────────────────────────────────────────────────

    @Test
    fun `tagListChanges is an add per new name and a style per recolour or emoji, nothing for a removed row`() {
        val changes = tagListChanges(
            TagScope.PET,
            baseline = listOf(def("Reactive"), def("Gone")),
            draft = listOf(def("reactive", icon = "⚠️"), def("Shy", token = "gold")),
        )
        assertEquals(
            listOf(
                TagChange(TagChange.STYLE, TagScope.PET, "reactive", paletteColor("teal"), "⚠️"),
                TagChange(TagChange.ADD, TagScope.PET, "Shy", paletteColor("gold"), ""),
            ),
            changes,
        )
    }

    @Test
    fun `a change goes out under the wire names the server reads`() {
        assertEquals(
            mapOf(
                "action" to "add",
                "scope" to "pet",
                "name" to "Shy",
                "color" to mapOf("token" to "teal", "css" to "var(--color-accent)"),
                "icon" to "",
            ),
            TagChange.addFromProfile(TagScope.PET, "  Shy ").toWire(),
        )
    }
}
