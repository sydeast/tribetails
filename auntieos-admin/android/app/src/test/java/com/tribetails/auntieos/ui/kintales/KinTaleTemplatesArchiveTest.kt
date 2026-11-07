package com.tribetails.auntieos.ui.kintales

import com.tribetails.auntieos.data.model.KinTaleTemplate
import com.tribetails.auntieos.data.model.KinTaleTemplateRemoval
import com.tribetails.auntieos.data.model.KinTaleTemplateUsage
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
import org.junit.Before
import org.junit.Test

/**
 * #1591 on the phone: Remove archives (restorable, out of the list), the
 * Archive panel restores or deletes for good, and delete waits for the count.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class KinTaleTemplatesArchiveTest {

    private val dispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository

    private val live = KinTaleTemplate(id = "t1", name = "Walk recap", isDefault = true)
    private val old = KinTaleTemplate(id = "t2", name = "Old sit", isDefault = true, archived = true)

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        repo = mockk()
        coEvery { repo.getKinTaleTemplates() } returns Result.success(listOf(live, old))
        coEvery { repo.removeKinTaleTemplate(any(), any(), any(), any()) } returns Result.success(Unit)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `an archived template is out of the list and in the archive`() = runTest(dispatcher) {
        val vm = KinTaleTemplatesViewModel(repo)
        advanceUntilIdle()
        assertEquals(listOf("t1"), vm.uiState.value.liveTemplates.map { it.id })
        assertEquals(listOf("t2"), vm.uiState.value.archivedTemplates.map { it.id })
    }

    @Test
    fun `Remove archives and never deletes`() = runTest(dispatcher) {
        val vm = KinTaleTemplatesViewModel(repo)
        advanceUntilIdle()
        vm.archive(live)
        advanceUntilIdle()
        coVerify(exactly = 1) { repo.removeKinTaleTemplate("t1", KinTaleTemplateRemoval.ARCHIVE, false, any()) }
        coVerify(exactly = 0) { repo.removeKinTaleTemplate(any(), KinTaleTemplateRemoval.DELETE, any(), any()) }
        assertEquals("Walk recap moved to the archive.", vm.uiState.value.notice)
    }

    @Test
    fun `Restore drops the default flag when another template is the default now`() = runTest(dispatcher) {
        val vm = KinTaleTemplatesViewModel(repo)
        advanceUntilIdle()
        vm.restore(old)
        advanceUntilIdle()
        coVerify(exactly = 1) { repo.removeKinTaleTemplate("t2", KinTaleTemplateRemoval.RESTORE, true, any()) }
    }

    @Test
    fun `delete for good waits for the usage count, then deletes`() = runTest(dispatcher) {
        coEvery { repo.getKinTaleTemplateUsage("t2") } returns
            Result.success(KinTaleTemplateUsage("t2", true, "Old sit", true, true, 3, 1, archived = true))
        val vm = KinTaleTemplatesViewModel(repo)
        advanceUntilIdle()
        vm.deleteForGood(old) // no count read yet
        coVerify(exactly = 0) { repo.removeKinTaleTemplate(any(), KinTaleTemplateRemoval.DELETE, any(), any()) }
        vm.loadDeleteUsage(old)
        advanceUntilIdle()
        assertEquals(3, vm.uiState.value.deleteUsage?.kintaleCount)
        vm.deleteForGood(old)
        advanceUntilIdle()
        coVerify(exactly = 1) { repo.removeKinTaleTemplate("t2", KinTaleTemplateRemoval.DELETE, false, any()) }
    }

    @Test
    fun `a live template is never deleted from the list`() = runTest(dispatcher) {
        coEvery { repo.getKinTaleTemplateUsage("t1") } returns
            Result.success(KinTaleTemplateUsage("t1", true, "Walk recap", true, true, 0, 1))
        val vm = KinTaleTemplatesViewModel(repo)
        advanceUntilIdle()
        vm.loadDeleteUsage(live)
        advanceUntilIdle()
        vm.deleteForGood(live)
        advanceUntilIdle()
        coVerify(exactly = 0) { repo.removeKinTaleTemplate(any(), KinTaleTemplateRemoval.DELETE, any(), any()) }
    }
}
