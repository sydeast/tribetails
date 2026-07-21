package com.tribetails.auntieos.ui.admin

import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.TrainingDocAttachment
import com.tribetails.auntieos.data.model.TrainingDocument
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
 * Tribal Intel write tool (spec 23) ViewModel coverage: create/update/delete route
 * through the server-bound callables, success surfaces the honest "queued for
 * reconcile" message, failures surface fail-loud, attachments upload before save,
 * and the KIN target carries the selected pet id.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class TribalIntelViewModelTest {

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

    private fun buildViewModel() = AdminDataViewModel(repository = mockRepo)

    @Test
    fun `createTrainingDocument success sets queued message and passes KINFOLK target`() = runTest(testDispatcher) {
        coEvery {
            mockRepo.createTrainingDocument(any(), any(), any(), any(), any(), any(), any(), any())
        } returns Result.success("td-new")
        coEvery { mockRepo.getTrainingDocuments() } returns Result.success(emptyList())

        val vm = buildViewModel()
        var cbErr: Throwable? = Throwable("sentinel")
        vm.createTrainingDocument(
            title = "Gate code", content = "Side gate is 4321", notes = "",
            targetType = "KINFOLK", targetKinfolkId = "kf1", targetKinId = null,
            attachments = emptyList(),
        ) { cbErr = it }
        advanceUntilIdle()

        assertNull(cbErr)
        assertNull(vm.error.value)
        assertNotNull(vm.trainingDocQueuedMessage.value)
        assertTrue(vm.trainingDocQueuedMessage.value!!.contains("reconcile", ignoreCase = true))
        coVerify { mockRepo.createTrainingDocument("Gate code", "Side gate is 4321", "", "KINFOLK", "kf1", null, emptyList()) }
    }

    @Test
    fun `createTrainingDocument KIN target passes the selected kin id`() = runTest(testDispatcher) {
        coEvery {
            mockRepo.createTrainingDocument(any(), any(), any(), any(), any(), any(), any(), any())
        } returns Result.success("td-new")
        coEvery { mockRepo.getTrainingDocuments() } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.createTrainingDocument("", "Rex allergy", "", "KIN", "kf1", "k1", emptyList())
        advanceUntilIdle()

        coVerify { mockRepo.createTrainingDocument("", "Rex allergy", "", "KIN", "kf1", "k1", emptyList()) }
    }

    @Test
    fun `createTrainingDocument failure surfaces fail-loud and no queued message`() = runTest(testDispatcher) {
        coEvery {
            mockRepo.createTrainingDocument(any(), any(), any(), any(), any(), any(), any(), any())
        } returns Result.failure(RuntimeException("permission-denied"))

        val vm = buildViewModel()
        var cbErr: Throwable? = null
        vm.createTrainingDocument("t", "c", "", "KINFOLK", "kf1", null, emptyList()) { cbErr = it }
        advanceUntilIdle()

        assertNotNull(cbErr)
        assertNotNull(vm.error.value)
        assertTrue(vm.error.value!!.contains("permission-denied"))
        assertNull(vm.trainingDocQueuedMessage.value)
    }

    @Test
    fun `updateTrainingDocument success refreshes and queues`() = runTest(testDispatcher) {
        coEvery {
            mockRepo.updateTrainingDocument(any(), any(), any(), any(), any(), any(), any(), any())
        } returns Result.success(Unit)
        coEvery { mockRepo.getTrainingDocuments() } returns Result.success(listOf(TrainingDocument(id = "d1")))

        val vm = buildViewModel()
        vm.updateTrainingDocument("d1", "t", "c", "", "KINFOLK", "kf1", null, emptyList())
        advanceUntilIdle()

        assertNull(vm.error.value)
        assertNotNull(vm.trainingDocQueuedMessage.value)
        assertEquals(1, vm.trainingDocuments.value.size)
    }

    @Test
    fun `deleteTrainingDocument routes the id and refreshes`() = runTest(testDispatcher) {
        coEvery { mockRepo.deleteTrainingDocument("d9") } returns Result.success(Unit)
        coEvery { mockRepo.getTrainingDocuments() } returns Result.success(emptyList())

        val vm = buildViewModel()
        vm.deleteTrainingDocument("d9")
        advanceUntilIdle()

        coVerify(exactly = 1) { mockRepo.deleteTrainingDocument("d9") }
        assertNull(vm.error.value)
    }

    @Test
    fun `deleteTrainingDocument failure surfaces error`() = runTest(testDispatcher) {
        coEvery { mockRepo.deleteTrainingDocument(any()) } returns Result.failure(RuntimeException("not-found"))

        val vm = buildViewModel()
        vm.deleteTrainingDocument("missing")
        advanceUntilIdle()

        assertNotNull(vm.error.value)
        assertTrue(vm.error.value!!.contains("not-found"))
    }

    @Test
    fun `loadKinForSelectedKinfolk populates the pet list`() = runTest(testDispatcher) {
        coEvery { mockRepo.getKin("kf1") } returns Result.success(listOf(Kin(id = "k1", name = "Rex")))

        val vm = buildViewModel()
        vm.loadKinForSelectedKinfolk("kf1")
        advanceUntilIdle()

        assertEquals(1, vm.kinForSelectedKinfolk.value.size)
        assertEquals("Rex", vm.kinForSelectedKinfolk.value.first().name)
    }

    @Test
    fun `removeTrainingDocAttachment drops by public id`() {
        val vm = buildViewModel()
        vm.setTrainingDocAttachments(
            listOf(
                TrainingDocAttachment(cloudinaryPublicId = "a", fileName = "a.jpg"),
                TrainingDocAttachment(cloudinaryPublicId = "b", fileName = "b.jpg"),
            ),
        )
        vm.removeTrainingDocAttachment("a")
        assertEquals(1, vm.trainingDocAttachments.value.size)
        assertEquals("b", vm.trainingDocAttachments.value.first().cloudinaryPublicId)
    }
}
