package com.tribetails.auntieos.ui.media

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Pure-helper tests for [mediaMetaLine] (spec 28 item 3), mirroring the web
 * MediaMetaLineTest: the caption meta line surfaces real uploadedAt (date prefix)
 * + uploadedBy, dropping blank or fabricated ("auntie") parts.
 */
class MediaMetaLineTest {

    @Test
    fun joinsDateAndAuthor() {
        assertEquals("2026-05-27 · jo@tribetails.com", mediaMetaLine("2026-05-27T09:41:00Z", "jo@tribetails.com"))
    }

    @Test
    fun dropsPlaceholderAuntieAuthor() {
        assertEquals("2026-05-27", mediaMetaLine("2026-05-27T09:41:00Z", "auntie"))
    }

    @Test
    fun dropsBlankAuthor() {
        assertEquals("2026-05-27", mediaMetaLine("2026-05-27", ""))
    }

    @Test
    fun dropsUnparseableDate() {
        assertEquals("uid-123", mediaMetaLine("not-a-date", "uid-123"))
    }

    @Test
    fun emptyWhenNothingReal() {
        assertEquals("", mediaMetaLine("", "auntie"))
    }
}
