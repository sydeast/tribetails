package com.kinfolk.portal.util

import android.content.Context
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/**
 * #1555: the Android store writes to SharedPreferences, so a dismissal must
 * read back from a fresh instance, the way it would after an app restart. Runs
 * under testDebugUnitTest (Robolectric), not :jvmTest.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class SharedPrefsBannerDismissalsTest {
    private fun prefs() = RuntimeEnvironment.getApplication()
        .getSharedPreferences("banner_dismissals_test", Context.MODE_PRIVATE)

    @After
    fun wipe() {
        prefs().edit().clear().commit()
    }

    @Test
    fun aDismissReadsBackFromAFreshInstance() {
        SharedPrefsBannerDismissals(::prefs).dismiss("banner-a")

        val afterRestart = SharedPrefsBannerDismissals(::prefs)
        assertTrue(afterRestart.isDismissed("banner-a"))
        assertFalse(afterRestart.isDismissed("banner-b"))
    }

    @Test
    fun clearForgetsEveryDismissalForAFreshInstanceToo() {
        val store = SharedPrefsBannerDismissals(::prefs)
        store.dismiss("banner-a")

        store.clear()

        assertFalse(store.isDismissed("banner-a"))
        assertFalse(SharedPrefsBannerDismissals(::prefs).isDismissed("banner-a"))
    }

    @Test
    fun withNoContextADismissStillHoldsForTheSession() {
        val store = SharedPrefsBannerDismissals { null }

        store.dismiss("banner-a")

        assertTrue(store.isDismissed("banner-a"))
        assertFalse(SharedPrefsBannerDismissals { null }.isDismissed("banner-a"))
    }
}
