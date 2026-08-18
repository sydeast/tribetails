package com.tribetails.auntieos.voice

import android.media.AudioDeviceInfo
import android.media.AudioManager
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The Android 8-11 Bluetooth path (#400). Choosing Bluetooth on those releases
 * used to publish "Bluetooth routing requires API 31+" and stop there, and the
 * route toggle greyed the Bluetooth cell out because availableRoutes() never
 * offered it. These pin the SCO behaviour that replaced that.
 *
 * Robolectric only supplies the AudioManager instance the constructor needs -
 * the API level under test is INJECTED (sdkInt = 30), not the one Robolectric
 * is emulating, so the legacy branch is exercised without needing an
 * android-all-30 runtime. Everything the legacy branch touches goes through
 * FakeLegacyAudioSystem, including the SCO broadcast and the connect timeout.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
@Suppress("DEPRECATION") // SCO_AUDIO_STATE_* are deprecated at API 31; that is the point.
class AudioRouterLegacyScoTest {

    private val audioManager: AudioManager
        get() = ApplicationProvider.getApplicationContext<android.content.Context>()
            .getSystemService(android.content.Context.AUDIO_SERVICE) as AudioManager

    private fun legacyRouter(
        fake: FakeLegacyAudioSystem,
        sdkInt: Int = 30,
    ) = AudioRouter(audioManager, fake, sdkInt = sdkInt, scoTimeoutMs = 4_000L)

    private fun fakeWithHeadset() = FakeLegacyAudioSystem().apply {
        setDevices(
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
            AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
        )
    }

    private fun fakeWithoutHeadset() = FakeLegacyAudioSystem().apply {
        setDevices(
            AudioDeviceInfo.TYPE_BUILTIN_EARPIECE,
            AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
        )
    }

    // ── The bug itself ───────────────────────────────────────────────────────

    @Test
    fun `on API 30 a connected headset routes to Bluetooth once SCO connects`() {
        val fake = fakeWithHeadset()
        val router = legacyRouter(fake)

        val accepted = router.setRoute(AudioRoute.Bluetooth)

        assertTrue("the Bluetooth request must be accepted, not refused", accepted)
        assertEquals("SCO must actually be started", 1, fake.startScoCalls)
        assertEquals(
            "SCO only carries call audio in communication mode",
            AudioManager.MODE_IN_COMMUNICATION,
            fake.audioMode,
        )
        assertEquals(
            "route must not claim Bluetooth before SCO reports connected",
            AudioRoute.Earpiece,
            router.currentRoute.value,
        )

        fake.emitScoState(AudioManager.SCO_AUDIO_STATE_CONNECTED)

        assertEquals(AudioRoute.Bluetooth, router.currentRoute.value)
        assertTrue("isBluetoothScoOn must be set once the link is up", fake.scoOn)
        assertNull("a successful route change publishes no error", router.audioRouteError.value)
    }

    @Test
    fun `on API 30 the route toggle offers Bluetooth when a headset is connected`() {
        val router = legacyRouter(fakeWithHeadset())

        assertEquals(
            setOf(AudioRoute.Earpiece, AudioRoute.Speaker, AudioRoute.Bluetooth),
            router.availableRoutes(),
        )
    }

    @Test
    fun `on API 30 the route toggle omits Bluetooth when no headset is connected`() {
        val router = legacyRouter(fakeWithoutHeadset())

        assertEquals(setOf(AudioRoute.Earpiece, AudioRoute.Speaker), router.availableRoutes())
    }

    // ── The failure modes ────────────────────────────────────────────────────

    @Test
    fun `no connected headset is refused by name and never starts SCO`() {
        val fake = fakeWithoutHeadset()
        val router = legacyRouter(fake)

        val accepted = router.setRoute(AudioRoute.Bluetooth)

        assertFalse(accepted)
        assertEquals(NO_BLUETOOTH_DEVICE_MESSAGE, router.audioRouteError.value)
        assertEquals("nothing to connect to, so nothing to start", 0, fake.startScoCalls)
        assertEquals(AudioRoute.Earpiece, router.currentRoute.value)
    }

    @Test
    fun `a SCO connect that never arrives times out onto the earpiece with a specific message`() {
        val fake = fakeWithHeadset()
        val router = legacyRouter(fake)
        router.setRoute(AudioRoute.Bluetooth)
        assertTrue("a timeout must be armed with the attempt", fake.timeoutScheduled)
        assertEquals(4_000L, fake.scheduledDelayMs)

        fake.fireTimeout()

        assertEquals(SCO_DID_NOT_CONNECT_MESSAGE, router.audioRouteError.value)
        assertEquals(
            "the call must land on the earpiece, not go silent",
            AudioRoute.Earpiece,
            router.currentRoute.value,
        )
        assertFalse("speakerphone must be off on the earpiece", fake.speakerOn)
        assertEquals("the half-open link must be torn down", 1, fake.stopScoCalls)
        assertNull("the listener must be detached", fake.scoListener)
    }

    @Test
    fun `an explicit SCO error falls back to the earpiece with the same message`() {
        val fake = fakeWithHeadset()
        val router = legacyRouter(fake)
        router.setRoute(AudioRoute.Bluetooth)

        fake.emitScoState(AudioManager.SCO_AUDIO_STATE_ERROR)

        assertEquals(SCO_DID_NOT_CONNECT_MESSAGE, router.audioRouteError.value)
        assertEquals(AudioRoute.Earpiece, router.currentRoute.value)
        assertEquals(1, fake.stopScoCalls)
        assertFalse("the timeout must not still be armed", fake.timeoutScheduled)
    }

    @Test
    fun `the sticky DISCONNECTED broadcast delivered on register does not abort the attempt`() {
        val fake = fakeWithHeadset()
        val router = legacyRouter(fake)
        router.setRoute(AudioRoute.Bluetooth)

        // ACTION_SCO_AUDIO_STATE_UPDATED is sticky: registering usually replays
        // a DISCONNECTED before the connect has had any chance to resolve.
        fake.emitScoState(AudioManager.SCO_AUDIO_STATE_DISCONNECTED)

        assertNull("a replayed DISCONNECTED is not a failure", router.audioRouteError.value)
        assertEquals(0, fake.stopScoCalls)

        fake.emitScoState(AudioManager.SCO_AUDIO_STATE_CONNECTED)

        assertEquals(AudioRoute.Bluetooth, router.currentRoute.value)
        assertNull(router.audioRouteError.value)
    }

    @Test
    fun `a headset that drops mid-call moves the call to the earpiece and says so`() {
        val fake = fakeWithHeadset()
        val router = legacyRouter(fake)
        router.setRoute(AudioRoute.Bluetooth)
        fake.emitScoState(AudioManager.SCO_AUDIO_STATE_CONNECTED)
        assertEquals(AudioRoute.Bluetooth, router.currentRoute.value)

        fake.emitScoState(AudioManager.SCO_AUDIO_STATE_DISCONNECTED)

        assertEquals(SCO_DROPPED_MESSAGE, router.audioRouteError.value)
        assertEquals(AudioRoute.Earpiece, router.currentRoute.value)
        assertFalse(fake.scoOn)
    }

    @Test
    fun `tapping Bluetooth twice while connecting starts only one SCO attempt`() {
        val fake = fakeWithHeadset()
        val router = legacyRouter(fake)

        router.setRoute(AudioRoute.Bluetooth)
        router.setRoute(AudioRoute.Bluetooth)

        assertEquals(1, fake.startScoCalls)
        assertEquals("no second listener may be attached", 1, fake.registerCalls)
    }

    @Test
    fun `tapping Bluetooth again once connected does not restart the link`() {
        val fake = fakeWithHeadset()
        val router = legacyRouter(fake)
        router.setRoute(AudioRoute.Bluetooth)
        fake.emitScoState(AudioManager.SCO_AUDIO_STATE_CONNECTED)

        router.setRoute(AudioRoute.Bluetooth)

        assertEquals(1, fake.startScoCalls)
        assertEquals(0, fake.stopScoCalls)
        assertEquals(AudioRoute.Bluetooth, router.currentRoute.value)
    }

    // ── Leaving Bluetooth, and cleanup ───────────────────────────────────────

    @Test
    fun `switching to Speaker from Bluetooth stops SCO without reporting a drop`() {
        val fake = fakeWithHeadset()
        val router = legacyRouter(fake)
        router.setRoute(AudioRoute.Bluetooth)
        fake.emitScoState(AudioManager.SCO_AUDIO_STATE_CONNECTED)

        val ok = router.setRoute(AudioRoute.Speaker)
        // The teardown itself makes the platform emit DISCONNECTED. Reading that
        // back as a dropped headset would toast an error the user just caused.
        fake.emitScoState(AudioManager.SCO_AUDIO_STATE_DISCONNECTED)

        assertTrue(ok)
        assertEquals(AudioRoute.Speaker, router.currentRoute.value)
        assertTrue(fake.speakerOn)
        assertEquals(1, fake.stopScoCalls)
        assertFalse(fake.scoOn)
        assertNull("leaving Bluetooth on purpose is not an error", router.audioRouteError.value)
    }

    @Test
    fun `Speaker and Earpiece still work on API 30 with no headset in the picture`() {
        val fake = fakeWithoutHeadset()
        val router = legacyRouter(fake)

        assertTrue(router.setRoute(AudioRoute.Speaker))
        assertTrue(fake.speakerOn)
        assertEquals(AudioRoute.Speaker, router.currentRoute.value)

        assertTrue(router.setRoute(AudioRoute.Earpiece))
        assertFalse(fake.speakerOn)
        assertEquals(AudioRoute.Earpiece, router.currentRoute.value)
        assertNull(router.audioRouteError.value)
    }

    @Test
    fun `release at the end of a Bluetooth call closes SCO and restores the audio mode`() {
        val fake = fakeWithHeadset()
        fake.audioMode = AudioManager.MODE_NORMAL
        val router = legacyRouter(fake)
        router.setRoute(AudioRoute.Bluetooth)
        fake.emitScoState(AudioManager.SCO_AUDIO_STATE_CONNECTED)

        router.release()

        assertEquals("SCO must not outlive the call", 1, fake.stopScoCalls)
        assertFalse(fake.scoOn)
        assertFalse(fake.speakerOn)
        assertNull("the receiver must not outlive the call", fake.scoListener)
        assertEquals(
            "the mode this router changed must be handed back",
            AudioManager.MODE_NORMAL,
            fake.audioMode,
        )
        assertEquals(AudioRoute.Earpiece, router.currentRoute.value)
    }

    @Test
    fun `release leaves the mode alone when the service already owned it`() {
        val fake = fakeWithHeadset()
        // IncomingCallNotificationService sets this before the router ever runs,
        // and restores it itself on the way down. Two owners writing it back
        // would fight.
        fake.audioMode = AudioManager.MODE_IN_COMMUNICATION
        val router = legacyRouter(fake)
        router.setRoute(AudioRoute.Bluetooth)
        fake.emitScoState(AudioManager.SCO_AUDIO_STATE_CONNECTED)

        router.release()

        assertEquals(AudioManager.MODE_IN_COMMUNICATION, fake.audioMode)
    }

    @Test
    fun `release after the timeout already fired is a harmless no-op`() {
        val fake = fakeWithHeadset()
        val router = legacyRouter(fake)
        router.setRoute(AudioRoute.Bluetooth)
        fake.fireTimeout()

        router.release()

        assertEquals("the link was already torn down once", 1, fake.stopScoCalls)
        assertEquals(AudioRoute.Earpiece, router.currentRoute.value)
    }

    @Test
    fun `a broadcast arriving after release is ignored`() {
        val fake = fakeWithHeadset()
        val router = legacyRouter(fake)
        router.setRoute(AudioRoute.Bluetooth)
        router.release()

        // The real receiver is unregistered by then, but a broadcast already in
        // flight can still land. It must not resurrect the route.
        router.onScoStateChanged(AudioManager.SCO_AUDIO_STATE_CONNECTED)

        assertEquals(AudioRoute.Earpiece, router.currentRoute.value)
    }

    // ── syncFromSystem ───────────────────────────────────────────────────────

    @Test
    fun `answering with SCO already up reports Bluetooth and adopts the link`() {
        val fake = fakeWithHeadset()
        fake.scoOn = true
        val router = legacyRouter(fake)

        router.syncFromSystem()

        assertEquals(AudioRoute.Bluetooth, router.currentRoute.value)
        assertNotNull("an adopted link still has to be watched for drops", fake.scoListener)

        fake.emitScoState(AudioManager.SCO_AUDIO_STATE_DISCONNECTED)

        assertEquals(SCO_DROPPED_MESSAGE, router.audioRouteError.value)
        assertEquals(AudioRoute.Earpiece, router.currentRoute.value)
    }

    @Test
    fun `answering on the speakerphone reports Speaker`() {
        val fake = fakeWithoutHeadset()
        fake.speakerOn = true
        val router = legacyRouter(fake)

        router.syncFromSystem()

        assertEquals(AudioRoute.Speaker, router.currentRoute.value)
    }

    // ── The API 31+ path is untouched ────────────────────────────────────────

    @Test
    fun `API 31 and up never reaches the legacy SCO seam`() {
        val fake = fakeWithHeadset()
        val router = AudioRouter(audioManager, fake, sdkInt = 31)

        router.setRoute(AudioRoute.Bluetooth)

        assertEquals("modern devices must keep using setCommunicationDevice", 0, fake.startScoCalls)
        assertEquals(0, fake.registerCalls)
    }

    @Test
    fun `API 26 gets the same legacy path as API 30`() {
        val fake = fakeWithHeadset()
        val router = legacyRouter(fake, sdkInt = 26)

        router.setRoute(AudioRoute.Bluetooth)
        fake.emitScoState(AudioManager.SCO_AUDIO_STATE_CONNECTED)

        assertEquals(AudioRoute.Bluetooth, router.currentRoute.value)
        assertEquals(1, fake.startScoCalls)
    }
}
