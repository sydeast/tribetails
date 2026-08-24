package com.tribetails.auntieos.media

import com.tribetails.auntieos.data.model.BusinessSettings
import com.tribetails.auntieos.data.model.LocationPoint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * ISSUE #519: `enablePhotoLocationTagging` decides whether a coordinate is
 * stored on a media record.
 *
 * Before this, the field had a control on three surfaces and no reader, and the
 * single `MediaMetadata(...)` construction site in the app never set `location`
 * either way. These cases fail against a `locationFor` that ignores the setting.
 */
class PhotoLocationTaggingTest {

    private val ping = LocationPoint(
        latitude = 30.2672,
        longitude = -97.7431,
        accuracy = 5f,
        timestamp = 1_700_000_000_000L,
    )

    private fun settings(tagging: Boolean, gps: Boolean = true) = BusinessSettings(
        enablePhotoLocationTagging = tagging,
        enableGPSTrackingForAllVisits = gps,
    )

    @Test
    fun `a photo is stamped when tagging is on`() {
        val out = PhotoLocationTagging.locationFor(settings(tagging = true), ping)
        assertEquals(30.2672, out!!.latitude, 0.0)
        assertEquals(-97.7431, out.longitude, 0.0)
        assertEquals(5f, out.accuracy)
    }

    @Test
    fun `NOTHING is stored when the operator turns tagging off`() {
        assertNull(PhotoLocationTagging.locationFor(settings(tagging = false), ping))
    }

    /** A business that turned GPS off has not agreed to store coordinates by another door. */
    @Test
    fun `the GPS master switch still wins over tagging`() {
        assertNull(PhotoLocationTagging.locationFor(settings(tagging = true, gps = false), ping))
    }

    @Test
    fun `a visit with no ping yet stamps nothing rather than guessing`() {
        assertNull(PhotoLocationTagging.locationFor(settings(tagging = true), null))
    }

    /** (0,0) is the LocationPoint default before a real fix landed, not a place. */
    @Test
    fun `Null Island is not a location`() {
        val unset = LocationPoint(latitude = 0.0, longitude = 0.0, timestamp = 1L)
        assertNull(PhotoLocationTagging.locationFor(settings(tagging = true), unset))
    }

    @Test
    fun `the newest ping wins, whatever order the trail arrives in`() {
        val older = ping.copy(latitude = 1.0, timestamp = 100L)
        val newest = ping.copy(latitude = 2.0, timestamp = 300L)
        val middle = ping.copy(latitude = 3.0, timestamp = 200L)
        assertEquals(newest, PhotoLocationTagging.latestPing(listOf(older, newest, middle)))
    }

    @Test
    fun `unstamped pings are ignored when picking the newest`() {
        val undated = ping.copy(latitude = 9.0, timestamp = 0L)
        val real = ping.copy(latitude = 2.0, timestamp = 300L)
        assertEquals(real, PhotoLocationTagging.latestPing(listOf(undated, real)))
        assertNull(PhotoLocationTagging.latestPing(listOf(undated)))
        assertNull(PhotoLocationTagging.latestPing(emptyList()))
    }

    /** The default settings tag, because both switches ship on. */
    @Test
    fun `a never-configured business tags its photos`() {
        assertEquals(
            30.2672,
            PhotoLocationTagging.locationFor(BusinessSettings(), ping)!!.latitude,
            0.0,
        )
    }
}
