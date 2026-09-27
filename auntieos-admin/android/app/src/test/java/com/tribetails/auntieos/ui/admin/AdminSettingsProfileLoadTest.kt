package com.tribetails.auntieos.ui.admin

import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.tribetails.auntieos.data.model.UserProfile
import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkStatic
import io.mockk.unmockkStatic
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #897 on Android: a failed profile read followed by Save wrote a blank profile.
 *
 * `observeUserProfile` sent null on a listener error. The view model took that
 * null as "no document", showed a blank placeholder profile, and handed
 * `saveUserProfile` a null baseline, which is its CREATE path: a whole-model
 * `set()` with no merge. So Save replaced the operator's document with blanks.
 *
 * The view model now reads through `observeUserProfileResult`, keeps "failed"
 * apart from "no document", and refuses every profile write until the read has
 * answered.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AdminSettingsProfileLoadTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: AuntieRepository

    private val stored = UserProfile(
        id = "u1",
        uid = "u1",
        email = "nia@tribetails.com",
        displayName = "Nia Okafor",
        phone = "555-0100",
        themeMode = "DARK",
    )

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        repo = mockk()
        val user = mockk<FirebaseUser>()
        every { user.uid } returns "u1"
        every { user.email } returns "nia@tribetails.com"
        val auth = mockk<FirebaseAuth>()
        every { auth.currentUser } returns user
        mockkStatic(FirebaseAuth::class)
        every { FirebaseAuth.getInstance() } returns auth
        coEvery { repo.saveUserProfile(any(), any()) } returns Result.success(Unit)
    }

    @After
    fun tearDown() {
        unmockkStatic(FirebaseAuth::class)
        Dispatchers.resetMain()
    }

    private fun vm() = AdminSettingsViewModel(repository = repo, mediaUploadManagerFactory = { mockk() })

    @Test
    fun `a failed read shows its error and Save writes nothing`() = runTest(testDispatcher) {
        every { repo.observeUserProfileResult("u1") } returns
            flowOf(Result.failure(IllegalStateException("PERMISSION_DENIED")))
        val vm = vm()
        vm.loadUserProfile()

        val state = vm.uiState.value
        assertFalse("a failed read is not a loaded profile", state.profileLoaded)
        assertEquals("Couldn't load your profile: PERMISSION_DENIED", state.profileLoadError)

        vm.saveProfile()
        vm.saveNavConfig(listOf("home"))

        coVerify(exactly = 0) { repo.saveUserProfile(any(), any()) }
        assertNotNull("the refusal is said, not swallowed", vm.uiState.value.error)
        assertFalse(vm.uiState.value.profileSaveSuccess)
    }

    @Test
    fun `Save before the read answers writes nothing`() = runTest(testDispatcher) {
        every { repo.observeUserProfileResult("u1") } returns MutableSharedFlow() // never answers
        val vm = vm()
        vm.loadUserProfile()

        vm.saveProfile()

        coVerify(exactly = 0) { repo.saveUserProfile(any(), any()) }
        assertEquals("Your profile is still loading. Nothing was saved.", vm.uiState.value.error)
    }

    @Test
    fun `retry after a failure loads the profile and Save diffs against it`() = runTest(testDispatcher) {
        every { repo.observeUserProfileResult("u1") } returns
            flowOf(Result.failure(IllegalStateException("UNAVAILABLE")))
        val vm = vm()
        vm.loadUserProfile()
        assertFalse(vm.uiState.value.profileLoaded)

        every { repo.observeUserProfileResult("u1") } returns flowOf(Result.success(stored))
        vm.loadUserProfile()

        assertTrue(vm.uiState.value.profileLoaded)
        assertNull(vm.uiState.value.profileLoadError)
        assertEquals("555-0100", vm.uiState.value.profile.phone)

        vm.updateProfileField { it.copy(phone = "555-0199") }
        vm.saveProfile()

        // The loaded document is the baseline, never null: the repository then
        // writes only `phone` (plus its stamp) under merge (UserProfileMergeTest).
        coVerify(exactly = 1) { repo.saveUserProfile(stored, match { it.phone == "555-0199" && it.displayName == "Nia Okafor" }) }
    }

    @Test
    fun `a failure after a good read keeps the loaded baseline`() = runTest(testDispatcher) {
        val updates = MutableSharedFlow<Result<UserProfile?>>()
        every { repo.observeUserProfileResult("u1") } returns updates
        val vm = vm()
        vm.loadUserProfile()
        updates.emit(Result.success(stored))
        updates.emit(Result.failure(IllegalStateException("UNAVAILABLE")))

        assertTrue(vm.uiState.value.profileLoaded)
        assertNull(vm.uiState.value.profileLoadError)
        assertEquals("Nia Okafor", vm.uiState.value.profile.displayName)

        vm.saveNavConfig(listOf("home"))
        coVerify(exactly = 1) { repo.saveUserProfile(stored, match { it.navConfig == listOf("home") }) }
    }

    @Test
    fun `a missing document is loaded, and Save creates it`() = runTest(testDispatcher) {
        every { repo.observeUserProfileResult("u1") } returns flowOf(Result.success(null))
        val vm = vm()
        vm.loadUserProfile()

        assertTrue("no document is a successful read", vm.uiState.value.profileLoaded)
        vm.updateProfileField { it.copy(displayName = "Nia") }
        vm.saveProfile()

        coVerify(exactly = 1) { repo.saveUserProfile(null, match { it.uid == "u1" && it.displayName == "Nia" }) }
    }
}
