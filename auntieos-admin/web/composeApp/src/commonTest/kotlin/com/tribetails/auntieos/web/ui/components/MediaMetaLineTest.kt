package com.tribetails.auntieos.web.ui.components

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * Pure-helper tests for [mediaMetaLine] (spec 28 item 3): the caption meta line
 * surfaces real uploadedAt (date prefix) + uploadedBy, dropping blank or
 * fabricated ("auntie") parts rather than printing them.
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

    /** #1564: uploads store the uploader's uid; the line shows their name. */
    @Test
    fun showsTheUploadersNameForAKnownUid() {
        val names = mapOf("nppJNdMNYJfUigibGKUQj3n4obt2" to "E2E Admin")
        assertEquals(
            "2026-05-27 · E2E Admin",
            mediaMetaLine("2026-05-27T09:41:00Z", "nppJNdMNYJfUigibGKUQj3n4obt2", names),
        )
    }

    @Test
    fun uploaderNamesUseNameThenEmailAndSkipNeither() {
        val names = com.tribetails.auntieos.web.data.uploaderNamesFrom(
            listOf(
                com.tribetails.auntieos.web.data.StaffMember("a", "E2E Admin", null),
                com.tribetails.auntieos.web.data.StaffMember("b", null, "catch@hanasamku.com"),
                com.tribetails.auntieos.web.data.StaffMember("c", null, null),
            ),
        )
        assertEquals(mapOf("a" to "E2E Admin", "b" to "catch@hanasamku.com"), names)
    }
}
