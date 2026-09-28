package com.tribetails.auntieos.web.ui.components

import com.tribetails.auntieos.web.data.FirestoreResult
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * #898: [ReadSnapshot] is the reducer behind [LiveRead] and [ReadStatusBanner].
 * Pinned directly (no Compose needed) because it is the one place that decides
 * loading vs. failed vs. stale vs. healthy. Get this wrong and every screen
 * built on it inherits the bug.
 */
class ReadSnapshotTest {

    @Test
    fun startsLoadingWithNoDataAndNoError() {
        val s = ReadSnapshot<List<String>>()
        assertTrue(s.loading)
        assertFalse(s.failed)
        assertFalse(s.stale)
    }

    @Test
    fun aFirstDataAnswerIsHealthy() {
        val s = ReadSnapshot<List<String>>().absorb(FirestoreResult.Data(listOf("a")))
        assertEquals(listOf("a"), s.data)
        assertTrue(s.hasLoaded)
        assertFalse(s.loading)
        assertFalse(s.failed)
        assertFalse(s.stale)
    }

    @Test
    fun aFirstErrorAnswerIsFailedNotStale() {
        val s = ReadSnapshot<List<String>>().absorb(FirestoreResult.Error("boom"))
        assertTrue(s.failed)
        assertFalse(s.stale)
        assertFalse(s.loading)
        assertEquals("boom", s.error)
        assertEquals(null, s.data)
    }

    @Test
    fun anErrorAfterAGoodReadIsStaleAndKeepsTheOldData() {
        val loaded = ReadSnapshot<List<String>>().absorb(FirestoreResult.Data(listOf("a", "b")))
        val polled = loaded.absorb(FirestoreResult.Error("timed out"))
        assertTrue(polled.stale)
        assertFalse(polled.failed)
        assertEquals(listOf("a", "b"), polled.data, "a dropped poll must not blank the last good data")
        assertEquals("timed out", polled.error)
    }

    @Test
    fun aGoodPollAfterAFailureClearsTheError() {
        val failed = ReadSnapshot<List<String>>().absorb(FirestoreResult.Error("boom"))
        val recovered = failed.absorb(FirestoreResult.Data(listOf("a")))
        assertFalse(recovered.failed)
        assertFalse(recovered.stale)
        assertEquals(null, recovered.error)
        assertEquals(listOf("a"), recovered.data)
    }

    @Test
    fun loadingDoesNotChangeAnAlreadyAnsweredSnapshot() {
        val loaded = ReadSnapshot<List<String>>().absorb(FirestoreResult.Data(listOf("a")))
        val polling = loaded.absorb(FirestoreResult.Loading)
        assertEquals(loaded, polling)
    }

    @Test
    fun aRealNullAnswerIsHealthyNotLoading() {
        // A read may legitimately answer with "no document yet" (null), which must
        // not be confused with "hasn't answered at all".
        val s = ReadSnapshot<String?>().absorb(FirestoreResult.Data(null))
        assertTrue(s.hasLoaded)
        assertFalse(s.loading)
        assertFalse(s.failed)
        assertEquals(null, s.data)
    }
}
