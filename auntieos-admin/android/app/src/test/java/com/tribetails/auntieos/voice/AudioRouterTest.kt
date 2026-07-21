package com.tribetails.auntieos.voice

import android.media.AudioDeviceInfo
import android.media.AudioManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.AudioDeviceInfoBuilder

/**
 * Robolectric SDK-35 interaction tests for AudioRouter. Verifies that
 * API 31+ paths call setCommunicationDevice and that StateFlow is published
 * on both success and failure.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class AudioRouterTest {

    private val audioManager: AudioManager
        get() = ApplicationProvider.getApplicationContext<android.content.Context>()
            .getSystemService(android.content.Context.AUDIO_SERVICE) as AudioManager

    private fun speakerDevice(): AudioDeviceInfo =
        AudioDeviceInfoBuilder.newBuilder()
            .setType(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
            .build()

    @Test
    fun `API 35 setRoute Speaker publishes Speaker on success`() {
        // Populate Robolectric's shadow with a Speaker comm device so the helper
        // can find a match; Robolectric's no-op setCommunicationDevice returns
        // true by default - the success path.
        shadowOf(audioManager).setAvailableCommunicationDevices(listOf(speakerDevice()))
        val router = AudioRouter(audioManager)
        val success = router.setRoute(AudioRoute.Speaker)
        assertTrue("setCommunicationDevice should succeed by default", success)
        assertEquals(AudioRoute.Speaker, router.currentRoute.value)
        assertNull(router.audioRouteError.value)
    }

    @Test
    fun `API 35 setCommunicationDevice failure surfaces error and does not change route`() {
        val router = AudioRouter(audioManager)
        // Robolectric: clear the list of available devices so the helper can't find a match.
        shadowOf(audioManager).setAvailableCommunicationDevices(emptyList())
        val priorRoute = router.currentRoute.value
        val success = router.setRoute(AudioRoute.Speaker)
        assertEquals(false, success)
        assertNotNull("error StateFlow must be non-null on failure", router.audioRouteError.value)
        assertEquals("route must not change on failure", priorRoute, router.currentRoute.value)
    }

    @Test
    fun `clearError resets audioRouteError to null`() {
        val router = AudioRouter(audioManager)
        shadowOf(audioManager).setAvailableCommunicationDevices(emptyList())
        router.setRoute(AudioRoute.Speaker) // forces error
        assertNotNull(router.audioRouteError.value)
        router.clearError()
        assertNull(router.audioRouteError.value)
    }
}
