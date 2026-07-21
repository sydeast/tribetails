package com.tribetails.auntieos.location

import com.tribetails.auntieos.data.model.LocationPoint
import com.tribetails.auntieos.data.repository.AuntieRepository
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Tests for BreadcrumbDispatcher + the pure helper `shouldLogOverflow`.
 *
 * Pure-helper tests verify the throttling math directly (no scope needed).
 * Dispatcher tests use UnconfinedTestDispatcher + runTest's backgroundScope
 * to drive the drain coroutine deterministically.
 *
 * Note: the actual DROP_OLDEST overflow path is intentionally NOT tested
 * here - it's a kotlinx.coroutines.channels.Channel guarantee and hard to
 * race deterministically in a unit test.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class BreadcrumbDispatcherTest {

    // ---------- pure helper: shouldLogOverflow ----------

    @Test
    fun `shouldLogOverflow returns true on first drop regardless of throttle`() {
        // First drop should always log so operators see the event immediately,
        // even if the throttle window hasn't elapsed.
        assertTrue(shouldLogOverflow(droppedCount = 1L, prevLoggedAt = 999_999L, now = 0L, throttleMs = 60_000L))
    }

    @Test
    fun `shouldLogOverflow returns true when window expired`() {
        assertTrue(shouldLogOverflow(droppedCount = 50L, prevLoggedAt = 1_000L, now = 61_001L, throttleMs = 60_000L))
    }

    @Test
    fun `shouldLogOverflow returns false when within throttle window`() {
        assertFalse(shouldLogOverflow(droppedCount = 50L, prevLoggedAt = 1_000L, now = 30_000L, throttleMs = 60_000L))
    }

    @Test
    fun `shouldLogOverflow returns true when throttle is zero`() {
        assertTrue(shouldLogOverflow(droppedCount = 50L, prevLoggedAt = 1_000L, now = 1_000L, throttleMs = 0L))
    }

    // ---------- dispatcher: send + drain ----------

    @Test
    fun `send enqueues and drain calls repository addBreadcrumb once`() = runTest(UnconfinedTestDispatcher()) {
        val repo = mockk<AuntieRepository>()
        coEvery { repo.addBreadcrumb(any(), any()) } returns Result.success("doc-id")

        val dispatcher = BreadcrumbDispatcher(repo, backgroundScope, capacity = 8)
        val ok = dispatcher.send("ses-1", LocationPoint(latitude = 1.0, longitude = 2.0))
        advanceUntilIdle()

        assertTrue(ok)
        coVerify(exactly = 1) { repo.addBreadcrumb("ses-1", any()) }
    }

    @Test
    fun `send rejects blank sessionId without invoking repository`() = runTest(UnconfinedTestDispatcher()) {
        val repo = mockk<AuntieRepository>()
        coEvery { repo.addBreadcrumb(any(), any()) } returns Result.success("doc-id")

        val dispatcher = BreadcrumbDispatcher(repo, backgroundScope, capacity = 8)
        val ok = dispatcher.send("", LocationPoint(latitude = 1.0, longitude = 2.0))
        advanceUntilIdle()

        assertFalse(ok)
        coVerify(exactly = 0) { repo.addBreadcrumb(any(), any()) }
    }

    @Test
    fun `multiple sends drain in order`() = runTest(UnconfinedTestDispatcher()) {
        val repo = mockk<AuntieRepository>()
        val captured = mutableListOf<LocationPoint>()
        val pointSlot = slot<LocationPoint>()
        coEvery { repo.addBreadcrumb(any(), capture(pointSlot)) } answers {
            captured.add(pointSlot.captured)
            Result.success("doc-id")
        }

        val dispatcher = BreadcrumbDispatcher(repo, backgroundScope, capacity = 32)
        val sent = (0 until 10).map { i ->
            LocationPoint(latitude = i.toDouble(), longitude = 0.0, timestamp = 1_000L + i)
        }
        sent.forEach { dispatcher.send("ses-1", it) }
        advanceUntilIdle()

        assertEquals(10, captured.size)
        // Order: timestamps in captured list must match send order.
        assertEquals(sent.map { it.timestamp }, captured.map { it.timestamp })
    }

    @Test
    fun `snapshotDroppedCount starts at zero`() = runTest(UnconfinedTestDispatcher()) {
        val repo = mockk<AuntieRepository>()
        coEvery { repo.addBreadcrumb(any(), any()) } returns Result.success("doc-id")
        val dispatcher = BreadcrumbDispatcher(repo, backgroundScope, capacity = 8)
        assertEquals(0L, dispatcher.snapshotDroppedCount())
    }
}
