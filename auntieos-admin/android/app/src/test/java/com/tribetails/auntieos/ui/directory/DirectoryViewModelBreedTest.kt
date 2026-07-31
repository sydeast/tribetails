package com.tribetails.auntieos.ui.directory

import com.tribetails.auntieos.data.model.BreedBank
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.data.model.Kinfolk
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.data.repository.InvoiceRepository
import com.tribetails.auntieos.data.repository.KinCareRepository
import io.mockk.coEvery
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
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Fail-loud gap this pins: `loadBreeds()` used to handle only `Result.onSuccess`,
 * so a rejected `getBreeds` call left `breedBank` at its empty default with NO
 * signal that anything had gone wrong. From the screen's point of view that was
 * indistinguishable from `dog_breeds` / `cat_breeds` genuinely not being seeded
 * yet -- both just an empty catalog, forever, with only a log line (`AuntieLog.e`
 * in `AuntieRepository.getBreeds`) that never reaches the operator.
 *
 * `breedBankFailed` is the fix: AddKinScreen / EditKinScreen read it to choose
 * between BreedSearch.breedBankNote's two disclosure messages instead of the
 * two causes rendering as the same silent, noteless field.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DirectoryViewModelBreedTest {

    private lateinit var viewModel: DirectoryViewModel
    private val repository = mockk<AuntieRepository>(relaxed = true)
    private val invoiceRepository = mockk<InvoiceRepository>(relaxed = true)
    private val kinCareRepository = mockk<KinCareRepository>(relaxed = true)
    private val testDispatcher = UnconfinedTestDispatcher()

    @Before
    fun setup() {
        Dispatchers.setMain(testDispatcher)
        coEvery { repository.getKinfolk() } returns Result.success(emptyList<Kinfolk>())
        coEvery { repository.getAllKin() } returns Result.success(emptyList<Kin>())
        coEvery { kinCareRepository.getKinCareSessions() } returns Result.success(emptyList())
        viewModel = DirectoryViewModel(repository, invoiceRepository, kinCareRepository)
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    @Test
    fun `a successful load populates the bank and carries no failure`() = runTest(testDispatcher) {
        coEvery { repository.getBreeds() } returns
            Result.success(BreedBank(dogBreeds = listOf("Boxer"), catBreeds = emptyList()))

        viewModel.loadBreeds()
        advanceUntilIdle()

        assertEquals(listOf("Boxer"), viewModel.breedBank.value.dogBreeds)
        assertFalse(viewModel.breedBankFailed.value)
    }

    @Test
    fun `a rejected call is disclosed through breedBankFailed, not just logged and dropped`() =
        runTest(testDispatcher) {
            coEvery { repository.getBreeds() } returns Result.failure(Exception("deadline-exceeded"))

            viewModel.loadBreeds()
            advanceUntilIdle()

            assertTrue(
                "a getBreeds failure must be visible to the screen, not silently swallowed",
                viewModel.breedBankFailed.value,
            )
            assertEquals(emptyList<String>(), viewModel.breedBank.value.dogBreeds)
            assertEquals(emptyList<String>(), viewModel.breedBank.value.catBreeds)
        }

    @Test
    fun `a later success clears a prior failure, since the bank is now genuinely loaded`() =
        runTest(testDispatcher) {
            coEvery { repository.getBreeds() } returns Result.failure(Exception("deadline-exceeded"))
            viewModel.loadBreeds()
            advanceUntilIdle()
            assertTrue(viewModel.breedBankFailed.value)

            // loadBreeds only skips a re-fetch once the bank is non-empty, so a
            // failed first attempt (bank still empty) is retried here, exactly as
            // it would be if the operator re-opened the screen.
            coEvery { repository.getBreeds() } returns
                Result.success(BreedBank(dogBreeds = listOf("Boxer"), catBreeds = emptyList()))
            viewModel.loadBreeds()
            advanceUntilIdle()

            assertFalse(viewModel.breedBankFailed.value)
            assertEquals(listOf("Boxer"), viewModel.breedBank.value.dogBreeds)
        }
}
