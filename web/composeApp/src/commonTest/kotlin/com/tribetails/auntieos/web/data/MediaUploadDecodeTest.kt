package com.tribetails.auntieos.web.data

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class MediaUploadDecodeTest {

    private val twoFiles = """
        {"ok":true,"files":[
          {"publicId":"tribetails/entity/h1/a","secureUrl":"https://x/a.jpg","resourceType":"image","format":"jpg","originalFileName":"a.jpg"},
          {"publicId":"tribetails/entity/h1/b","secureUrl":"https://x/b.jpg","resourceType":"image","format":"jpg","originalFileName":"b.jpg"}
        ]}
    """.trimIndent()

    @Test fun decodesEveryFile_notJustFirst() {
        // The bug: the old single path took files.first(), so picking N images saved 1.
        val r = decodeUploadedMedia(twoFiles, "h1", "kinfolk", "NOW", "uid1")
        assertTrue(r is WriteResult.Ok)
        val list = (r as WriteResult.Ok).value
        assertEquals(2, list.size)
        assertEquals(listOf("a", "b"), list.map { it.fileName })
    }

    @Test fun stampsKinfolkId_whenEntityIsHousehold() {
        val r = decodeUploadedMedia(twoFiles, "h1", "kinfolk", "NOW", "uid1") as WriteResult.Ok
        assertTrue(r.value.all { it.kinfolkId == "h1" })
    }

    @Test fun noKinfolkId_forNonHouseholdEntity() {
        val r = decodeUploadedMedia(twoFiles, "k9", "KIN", "NOW", "uid1") as WriteResult.Ok
        assertTrue(r.value.all { it.kinfolkId == "" })
    }

    @Test fun failLoud_whenNotOk() {
        val r = decodeUploadedMedia("""{"ok":false,"error":"quota exceeded"}""", "h1", "kinfolk", "NOW", "uid1")
        assertTrue(r is WriteResult.Err)
        assertEquals("quota exceeded", (r as WriteResult.Err).message)
    }

    @Test fun videoGetsVideoTypeAndDeliveryUrl() {
        val v = """{"ok":true,"files":[{"publicId":"p","resourceType":"video","format":"mp4","durationSeconds":3}]}"""
        val list = (decodeUploadedMedia(v, "s1", "VISIT_LOG", "NOW", "uid") as WriteResult.Ok).value
        assertEquals("VIDEO", list[0].fileType)
        assertTrue(list[0].storageUrl.contains("/video/"))
    }

    @Test fun okButEmptyFiles_returnsEmpty() {
        val r = decodeUploadedMedia("""{"ok":true,"files":[]}""", "h1", "kinfolk", "NOW", "uid") as WriteResult.Ok
        assertEquals(emptyList(), r.value)
    }

    @Test fun appliesTagsToEveryRecord() {
        val r = decodeUploadedMedia(twoFiles, "s1", "VISIT_LOG", "NOW", "uid", tags = listOf("kintale")) as WriteResult.Ok
        assertTrue(r.value.all { it.tags == listOf("kintale") })
    }
}
