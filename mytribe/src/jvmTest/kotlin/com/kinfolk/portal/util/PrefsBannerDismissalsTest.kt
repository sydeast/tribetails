package com.kinfolk.portal.util

import java.util.UUID
import java.util.prefs.Preferences
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #1555: the desktop store writes to a real user preferences node, so a
 * dismissal must read back from a fresh instance, the way it would after an
 * app restart. Each test runs on its own throwaway node and removes it, so
 * nothing reaches the node the shipping app reads.
 */
class PrefsBannerDismissalsTest {
    private val nodePath = "com/kinfolk/portal/test/dismissedBanners-${UUID.randomUUID()}"

    @AfterTest
    fun removeNode() {
        runCatching {
            Preferences.userRoot().node(nodePath).removeNode()
            Preferences.userRoot().flush()
        }
    }

    @Test
    fun aDismissReadsBackFromAFreshInstance() {
        PrefsBannerDismissals(nodePath).dismiss("banner-a")

        val afterRestart = PrefsBannerDismissals(nodePath)
        assertTrue(afterRestart.isDismissed("banner-a"))
        assertFalse(afterRestart.isDismissed("banner-b"))
    }

    @Test
    fun clearForgetsEveryDismissalForAFreshInstanceToo() {
        val store = PrefsBannerDismissals(nodePath)
        store.dismiss("banner-a")
        store.dismiss("banner-b")

        store.clear()

        assertFalse(store.isDismissed("banner-a"))
        assertFalse(PrefsBannerDismissals(nodePath).isDismissed("banner-b"))
    }

    @Test
    fun anIdTooLongForAPreferencesKeyStillHoldsForTheSession() {
        val longId = "b".repeat(Preferences.MAX_KEY_LENGTH + 1)
        val store = PrefsBannerDismissals(nodePath)

        store.dismiss(longId)

        assertTrue(store.isDismissed(longId))
    }

    @Test
    fun theDeviceStoreIsThePreferencesBackedOne() {
        assertTrue(deviceBannerDismissals() is PrefsBannerDismissals)
    }
}
