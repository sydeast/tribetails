package com.tribetails.auntieos.ui.components

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * #802. Ports web's `lib/mediaFormat.test.ts#mediaDurationLabel` cases
 * verbatim, so the two platforms cannot drift on what "1:15" or "no duration"
 * means for the same `durationSeconds` value. Every media surface that shows
 * a video length (the kit's [AuntieMediaCell] badge, the per-entity Media
 * screen's tile badge, and both fullscreen viewers) goes through
 * [mediaDurationLabel] (or the [formatDuration] it wraps), so pinning this
 * pure function pins every one of those surfaces' actual text.
 */
class MediaDurationLabelTest {

    @Test
    fun `m colon ss for a duration under an hour`() {
        assertEquals("1:15", mediaDurationLabel(75))
        assertEquals("0:09", mediaDurationLabel(9))
    }

    @Test
    fun `h colon mm colon ss once an hour is crossed`() {
        assertEquals("1:02:05", mediaDurationLabel(3725))
    }

    @Test
    fun `zero or negative never fabricates a label`() {
        assertNull(mediaDurationLabel(0))
        assertNull(mediaDurationLabel(-5))
    }

    @Test
    fun `formatDuration itself renders the same mm ss shape the badge uses`() {
        assertEquals("1:15", formatDuration(75))
        assertEquals("1:02:05", formatDuration(3725))
    }
}
