package com.kinfolk.portal.util

import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** #1555: the store routes through its backing, and a blank id is never recorded. */
class BannerDismissStoreTest {
    private val device = BannerDismissStore.backing
    private val memory = InMemoryBannerDismissals()

    @BeforeTest
    fun useMemory() {
        BannerDismissStore.backing = memory
    }

    @AfterTest
    fun restoreDevice() {
        BannerDismissStore.backing = device
    }

    @Test
    fun aDismissedBannerReadsAsDismissed() {
        BannerDismissStore.dismiss("banner-a")

        assertTrue(BannerDismissStore.isDismissed("banner-a"))
        assertTrue(memory.isDismissed("banner-a"))
        assertFalse(BannerDismissStore.isDismissed("banner-b"))
    }

    @Test
    fun aBlankIdIsNeverRecordedOrReadAsDismissed() {
        BannerDismissStore.dismiss("")
        BannerDismissStore.dismiss("  ")

        assertFalse(memory.isDismissed(""))
        assertFalse(memory.isDismissed("  "))
        assertFalse(BannerDismissStore.isDismissed(""))
    }

    @Test
    fun clearingTheBackingBringsTheBannerBack() {
        BannerDismissStore.dismiss("banner-a")

        memory.clear()

        assertFalse(BannerDismissStore.isDismissed("banner-a"))
    }
}
