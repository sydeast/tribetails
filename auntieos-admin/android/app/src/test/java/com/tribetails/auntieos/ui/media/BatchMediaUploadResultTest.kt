package com.tribetails.auntieos.ui.media

import android.net.Uri
import com.tribetails.auntieos.data.model.MediaEntityType
import com.tribetails.auntieos.data.model.MediaFile
import com.tribetails.auntieos.data.model.MediaType
import com.tribetails.auntieos.media.BatchMediaUploadResult
import io.mockk.every
import io.mockk.mockk
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * NOTE-45: Verifies BatchMediaUploadResult correctly preserves successes on
 * partial failure and never silently discards uploaded files.
 */
class BatchMediaUploadResultTest {

    private fun mediaFile(id: String) = MediaFile(
        id = id,
        entityId = "sess-1",
        entityType = MediaEntityType.VISIT_LOG.name,
        fileType = MediaType.IMAGE,
    )

    private fun uri(path: String): Uri = mockk<Uri>().also {
        every { it.toString() } returns path
    }

    @Test
    fun `all succeed - hasFailures false, totalRequested equals succeeded count`() {
        val result = BatchMediaUploadResult(
            succeeded = listOf(mediaFile("m1"), mediaFile("m2")),
            failed = emptyList(),
        )
        assertFalse(result.hasFailures)
        assertEquals(2, result.totalRequested)
        assertEquals(2, result.succeeded.size)
        assertEquals(0, result.failed.size)
    }

    @Test
    fun `all fail - succeeded list is empty, hasFailures true`() {
        val u1 = uri("content://a")
        val u2 = uri("content://b")
        val result = BatchMediaUploadResult(
            succeeded = emptyList(),
            failed = listOf(u1 to "Network error", u2 to "Timeout"),
        )
        assertTrue(result.hasFailures)
        assertEquals(2, result.totalRequested)
        assertEquals(0, result.succeeded.size)
        assertEquals(2, result.failed.size)
    }

    @Test
    fun `partial success - successes preserved, failures also surfaced`() {
        val u2 = uri("content://fail")
        val result = BatchMediaUploadResult(
            succeeded = listOf(mediaFile("m1")),
            failed = listOf(u2 to "Upload rejected"),
        )
        assertTrue(result.hasFailures)
        assertEquals(2, result.totalRequested)
        assertEquals(1, result.succeeded.size)
        assertEquals("m1", result.succeeded[0].id)
        assertEquals(1, result.failed.size)
        assertEquals("Upload rejected", result.failed[0].second)
    }

    @Test
    fun `totalRequested matches sum of succeeded and failed`() {
        val result = BatchMediaUploadResult(
            succeeded = listOf(mediaFile("a"), mediaFile("b"), mediaFile("c")),
            failed = listOf(uri("content://x") to "err", uri("content://y") to "err"),
        )
        assertEquals(5, result.totalRequested)
    }
}
