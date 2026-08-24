package com.tribetails.auntieos.ui.admin

import android.content.Context
import android.net.Uri
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.tribetails.auntieos.data.model.MediaFile
import com.tribetails.auntieos.data.repository.AuntieRepository
import com.tribetails.auntieos.media.MediaUploadManager
import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkStatic
import io.mockk.unmockkStatic
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
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
 * #518: the admin/operator profile-photo upload (AdminSettingsScreen.kt's
 * ProfilePanel -> AdminSettingsViewModel.uploadAvatar) was already real and honestly
 * labelled on Android (see AdminSettingsScreen.kt:589 "Profile photo" contentDescription
 * and the "Change Picture" button), but had NO test coverage at all - the false-dark
 * state fixed on desktop (JvmMediaUpload / SettingsScreen.kt) had no Android
 * counterpart, but the missing PROOF that the honest label matches real behavior did.
 * This file is that proof: happy path, both failure stages, and the signed-out guard.
 *
 * [AdminSettingsViewModel.mediaUploadManagerFactory] is the test seam - `uploadAvatar`
 * would otherwise construct a real `MediaUploadManager(context, repository)`, which
 * needs a real android.content.Context / ContentResolver / OkHttp that a plain JVM
 * unit test cannot provide.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class AdminSettingsAvatarUploadTest {

    private val testDispatcher = UnconfinedTestDispatcher()
    private lateinit var mockRepo: AuntieRepository
    private lateinit var mockManager: MediaUploadManager
    private lateinit var mockUser: FirebaseUser
    private val fakeContext: Context = mockk(relaxed = true)
    private val fakeUri: Uri = mockk(relaxed = true)

    @Before
    fun setUp() {
        Dispatchers.setMain(testDispatcher)
        mockRepo = mockk()
        mockManager = mockk()
        mockUser = mockk()
        every { mockUser.uid } returns "operator-uid"
        every { mockUser.email } returns "operator@tribetails.com"
        mockkStatic(FirebaseAuth::class)
    }

    @After
    fun tearDown() {
        unmockkStatic(FirebaseAuth::class)
        Dispatchers.resetMain()
    }

    private fun signedIn() {
        val auth = mockk<FirebaseAuth>()
        every { auth.currentUser } returns mockUser
        every { FirebaseAuth.getInstance() } returns auth
    }

    private fun signedOut() {
        val auth = mockk<FirebaseAuth>()
        every { auth.currentUser } returns null
        every { FirebaseAuth.getInstance() } returns auth
    }

    private fun buildViewModel() = AdminSettingsViewModel(
        repository = mockRepo,
        mediaUploadManagerFactory = { mockManager },
    )

    // ─── happy path ─────────────────────────────────────────────────────────

    @Test
    fun `uploadAvatar success stamps photoUrl and reports success`() = runTest(testDispatcher) {
        signedIn()
        val uploaded = MediaFile(storageUrl = "https://res.cloudinary.com/demo/image/upload/avatar.jpg")
        coEvery { mockManager.uploadMedia(any(), any(), any(), any(), any(), any()) } returns Result.success(uploaded)
        coEvery { mockRepo.saveUserProfile(any(), any()) } returns Result.success(Unit)

        val vm = buildViewModel()
        vm.uploadAvatar(fakeContext, fakeUri)

        val state = vm.uiState.value
        assertFalse("upload must finish, not stay spinning", state.isUploadingAvatar)
        assertNull("a successful upload must not leave a stale error", state.error)
        assertTrue("profileSaveSuccess must flip so the screen can toast it", state.profileSaveSuccess)
        assertEquals(uploaded.storageUrl, state.profile.photoUrl)
    }

    // ─── rejected: the upload itself fails ──────────────────────────────────

    @Test
    fun `uploadAvatar rejected surfaces the upload failure, never a fake success`() = runTest(testDispatcher) {
        signedIn()
        coEvery { mockManager.uploadMedia(any(), any(), any(), any(), any(), any()) } returns
            Result.failure(IllegalStateException("Selected media exceeds the 50MB limit"))

        val vm = buildViewModel()
        vm.uploadAvatar(fakeContext, fakeUri)

        val state = vm.uiState.value
        assertFalse(state.isUploadingAvatar)
        assertFalse("a rejected upload must never report success", state.profileSaveSuccess)
        assertEquals("Avatar upload failed: Selected media exceeds the 50MB limit", state.error)
        assertEquals("a rejected upload must not touch the displayed photo", "", state.profile.photoUrl)
    }

    // ─── rejected: upload OK, but the profile write fails (two-stage fail-loud) ──

    @Test
    fun `uploadAvatar surfaces the profile-save failure separately from the upload`() = runTest(testDispatcher) {
        signedIn()
        val uploaded = MediaFile(storageUrl = "https://res.cloudinary.com/demo/image/upload/avatar.jpg")
        coEvery { mockManager.uploadMedia(any(), any(), any(), any(), any(), any()) } returns Result.success(uploaded)
        coEvery { mockRepo.saveUserProfile(any(), any()) } returns Result.failure(IllegalStateException("offline"))

        val vm = buildViewModel()
        vm.uploadAvatar(fakeContext, fakeUri)

        val state = vm.uiState.value
        assertFalse(state.isUploadingAvatar)
        assertFalse(state.profileSaveSuccess)
        assertEquals("Avatar uploaded but profile save failed: offline", state.error)
    }

    // ─── signed out ─────────────────────────────────────────────────────────

    @Test
    fun `uploadAvatar with no signed-in user fails loud and never touches the media manager`() = runTest(testDispatcher) {
        signedOut()

        val vm = buildViewModel()
        vm.uploadAvatar(fakeContext, fakeUri)

        assertEquals("Sign in required to upload avatar", vm.uiState.value.error)
        assertFalse(vm.uiState.value.isUploadingAvatar)
    }
}
