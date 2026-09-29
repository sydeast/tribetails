package com.tribetails.auntieos.ui.admin

import android.content.Context
import android.net.Uri
import com.tribetails.auntieos.data.model.MediaEntityType
import com.tribetails.auntieos.data.model.MediaFile
import com.tribetails.auntieos.data.repository.EmailFrameRepository
import com.tribetails.auntieos.media.MediaUploadManager
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * #957: the Android Email frame panel's view model against a mocked repository.
 * The save is checked diff-vs-rebuild: only what the operator changed is sent,
 * so a field this client has no control for is never wiped.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class EmailFrameViewModelTest {

    private val dispatcher = UnconfinedTestDispatcher()
    private lateinit var repo: EmailFrameRepository

    private val defaults = mapOf(
        "accentColor" to "#df8431", "headlineColor" to "#11131f", "textColor" to "#11131f",
        "buttonTextColor" to "#ffffff", "pageBackground" to "#fbfbf9", "cardBackground" to "#ffffff",
        "calloutBackground" to "#fff5f5", "footerBackground" to "#11131f", "footerTextColor" to "#fbfbf9",
        "headerText" to "", "footerText" to "Tribe Tails Pet Care. Your Kin's Favorite Auntie.", "logoUrl" to "",
    )

    private fun state(stored: Map<String, String>) =
        EmailFrameRepository.EmailFrameState(stored = stored, defaults = defaults, updatedAt = null, updatedBy = null)

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        repo = mockk()
    }

    @After
    fun tearDown() { Dispatchers.resetMain() }

    @Test
    fun `load seeds the draft from stored values only, never from defaults`() = runTest {
        coEvery { repo.getEmailFrame() } returns Result.success(state(mapOf("accentColor" to "#123456")))
        val vm = EmailFrameViewModel(repo)
        assertEquals("#123456", vm.state.value.draft["accentColor"])
        assertEquals("", vm.state.value.draft["footerText"])
        assertTrue(vm.pendingChanges().isEmpty())
    }

    @Test
    fun `save sends only the changed fields, and a cleared field as null`() = runTest {
        // `futureField` stands for a field a newer server holds that this client
        // has no control for. It must not appear in the save at all.
        val stored = mapOf("accentColor" to "#123456", "footerText" to "Old", "futureField" to "keep me")
        coEvery { repo.getEmailFrame() } returns Result.success(state(stored))
        coEvery { repo.saveEmailFrame(any()) } returns Result.success(state(mapOf("footerText" to "New", "futureField" to "keep me")))
        val vm = EmailFrameViewModel(repo)
        vm.edit("footerText", "New")
        vm.edit("accentColor", "")
        vm.save()
        coVerify(exactly = 1) { repo.saveEmailFrame(mapOf("footerText" to "New", "accentColor" to null)) }
        assertEquals("Saved. The next email sent uses it.", vm.state.value.savedNote)
        assertEquals("New", vm.state.value.draft["footerText"])
    }

    @Test
    fun `save does nothing when nothing changed or a field is invalid`() = runTest {
        coEvery { repo.getEmailFrame() } returns Result.success(state(emptyMap()))
        val vm = EmailFrameViewModel(repo)
        vm.save()
        vm.edit("accentColor", "orange")
        vm.save()
        coVerify(exactly = 0) { repo.saveEmailFrame(any()) }
    }

    @Test
    fun `a failed save keeps the draft and shows why`() = runTest {
        coEvery { repo.getEmailFrame() } returns Result.success(state(emptyMap()))
        coEvery { repo.saveEmailFrame(any()) } returns Result.failure(RuntimeException("The logo must be an image uploaded to the business library."))
        val vm = EmailFrameViewModel(repo)
        vm.edit("headerText", "Tribe Tails")
        vm.save()
        assertEquals("The logo must be an image uploaded to the business library.", vm.state.value.error)
        assertEquals("Tribe Tails", vm.state.value.draft["headerText"])
        assertNull(vm.state.value.busy)
        assertNull(vm.state.value.savedNote)
    }

    @Test
    fun `reset calls the reset callable and clears the draft`() = runTest {
        coEvery { repo.getEmailFrame() } returns Result.success(state(mapOf("accentColor" to "#123456")))
        coEvery { repo.resetEmailFrame() } returns Result.success(state(emptyMap()))
        val vm = EmailFrameViewModel(repo)
        vm.reset()
        coVerify(exactly = 1) { repo.resetEmailFrame() }
        assertEquals("", vm.state.value.draft["accentColor"])
        assertEquals("Back to the default frame.", vm.state.value.savedNote)
    }

    @Test
    fun `a failed load says so and retries`() = runTest {
        coEvery { repo.getEmailFrame() } returnsMany listOf(Result.failure(RuntimeException("permission-denied")), Result.success(state(emptyMap())))
        val vm = EmailFrameViewModel(repo)
        assertTrue(vm.state.value.load is EmailFrameViewModel.Load.Failed)
        vm.load()
        assertTrue(vm.state.value.load is EmailFrameViewModel.Load.Ready)
    }

    @Test
    fun `a logo upload lands in the draft as logoUrl, in the business library`() = runTest {
        val url = "https://res.cloudinary.com/tribetails/image/upload/v1/tribetails/business/business_settings/logo.png"
        coEvery { repo.getEmailFrame() } returns Result.success(state(emptyMap()))
        val manager = mockk<MediaUploadManager>()
        coEvery { manager.uploadMedia(any(), any(), any(), any(), any(), any(), any()) } returns
            Result.success(MediaFile(storageUrl = url))
        val vm = EmailFrameViewModel(repo) { manager }
        vm.uploadLogo(mockk<Context>(), mockk<Uri>())
        // The business library: the folder the server's logo check accepts.
        coVerify { manager.uploadMedia(any(), "business_settings", MediaEntityType.BUSINESS, any(), any(), any(), any()) }
        assertEquals(url, vm.state.value.draft["logoUrl"])
        assertEquals(mapOf<String, String?>("logoUrl" to url), vm.pendingChanges())
    }
}
