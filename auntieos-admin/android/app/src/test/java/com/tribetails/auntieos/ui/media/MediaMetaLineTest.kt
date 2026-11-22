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
        assertEquals("2026-05-27 · Jo", mediaMetaLine("2026-05-27T09:41:00Z", "Jo"))
    }

    /** #1882: the walk read "2026-07-20 · [email]" under a picture. */
    @Test
    fun leavesOffAnEmailOrAnUnknownUid() {
        assertEquals("2026-05-27", mediaMetaLine("2026-05-27T09:41:00Z", "e2e-admin@tribetails.com"))
        assertEquals("2026-05-27", mediaMetaLine("2026-05-27T09:41:00Z", "nppJNdMNYJfUigibGKUQj3n4obt2"))
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
    fun anUnknownUidStaysAsStored() {
        assertEquals("2026-05-27 · u9", mediaMetaLine("2026-05-27T09:41:00Z", "u9", mapOf("u1" to "E2E Admin")))
    }

    @Test
    fun staffNamesByUidUsesNameThenRoleNeverEmail() {
        val names = com.tribetails.auntieos.data.repository.staffNamesByUid(
            listOf(
                com.tribetails.auntieos.data.repository.StaffMember("a", "E2E Admin", null),
                com.tribetails.auntieos.data.repository.StaffMember("b", null, "catch@hanasamku.com", role = "owner"),
                com.tribetails.auntieos.data.repository.StaffMember("c", "pawsome@hanasamku.com", null, role = "auntie"),
                com.tribetails.auntieos.data.repository.StaffMember("d", null, null),
            ),
        )
        // #1882: no name on file reads as the role, the words the visit notes sign with.
        assertEquals(mapOf("a" to "E2E Admin", "b" to "Office", "c" to "Auntie", "d" to "Staff"), names)
    }
}
