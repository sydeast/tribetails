package com.tribetails.auntieos.media

import com.tribetails.auntieos.data.model.MediaFile
import com.tribetails.auntieos.data.model.MediaType
import com.tribetails.auntieos.ui.media.mediaGpsStripFailed
import io.mockk.mockk
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #593: what Android writes about the asynchronous video location strip, and
 * what it shows about it.
 *
 * The strip itself happens server-side (a `media_files` create trigger in
 * mytribe/functions). Android's two jobs are to QUEUE a video for it, and to
 * SAY SO when it did not work — a video whose strip failed still carries the
 * coordinates it was recorded with, and that is the one state an operator has
 * to be able to see without reading a Cloud Run log.
 */
class VideoGpsStripStateTest {

    private fun manager() = MediaUploadManager(mockk(relaxed = true), mockk(relaxed = true))

    // ── 1. queueing ─────────────────────────────────────────────────────────

    @Test
    fun `a video is queued for the asynchronous strip`() {
        assertEquals("PENDING", manager().gpsStripStatusFor(MediaType.VIDEO))
    }

    @Test
    fun `an image is not queued - it was stripped before Cloudinary stored it`() {
        // #583 signs `fl_force_strip` as an INCOMING transformation on every
        // photo, so the stored original is already clean. Marking it PENDING
        // would leave a permanent false positive in the retry sweep's queue.
        assertEquals("", manager().gpsStripStatusFor(MediaType.IMAGE))
    }

    @Test
    fun `audio and documents are not queued either`() {
        assertEquals("", manager().gpsStripStatusFor(MediaType.AUDIO))
        assertEquals("", manager().gpsStripStatusFor(MediaType.DOCUMENT))
    }

    @Test
    fun `a fresh MediaFile carries no strip state, so the repository can delete the key`() {
        // Blank is what the repository keys off to DELETE the field rather than
        // write "". Absent and blank are two different things to a Firestore
        // query, and only absent means "no async strip applies here".
        assertEquals("", MediaFile().gpsStripStatus)
        assertEquals(0, MediaFile().gpsStripAttempts)
    }

    // ── 2. showing it ───────────────────────────────────────────────────────

    @Test
    fun `only FAILED is badged`() {
        assertTrue(mediaGpsStripFailed(MediaFile(gpsStripStatus = "FAILED")))
        // PENDING is ordinary progress measured in seconds; badging it would
        // put an alarming label on every video the moment it lands.
        assertFalse(mediaGpsStripFailed(MediaFile(gpsStripStatus = "PENDING")))
        // STRIPPED is the expected outcome and needs no decoration.
        assertFalse(mediaGpsStripFailed(MediaFile(gpsStripStatus = "STRIPPED")))
    }

    @Test
    fun `the field is read as free text, case- and whitespace-insensitively`() {
        assertTrue(mediaGpsStripFailed(MediaFile(gpsStripStatus = " failed ")))
        assertTrue(mediaGpsStripFailed(MediaFile(gpsStripStatus = "Failed")))
    }

    @Test
    fun `an absent state is not badged, and is equally not a claim that it is clean`() {
        // Every image, and every video that predates #593. The badge only ever
        // makes the one claim it can back up.
        assertFalse(mediaGpsStripFailed(MediaFile()))
        assertFalse(mediaGpsStripFailed(MediaFile(gpsStripStatus = "RUNNING")))
    }
}
