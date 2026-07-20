package com.kinfolk.portal.media

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class KinPhotoPolicyTest {

    private fun image(
        bytes: ByteArray = byteArrayOf(1, 2, 3),
        mime: String = "image/jpeg",
        name: String = "bud.jpg",
    ) = PickedImage(bytes = bytes, mimeType = mime, fileName = name)

    @Test
    fun acceptsAllowedMimeTypesUnderTheCap() {
        for (mime in listOf("image/jpeg", "image/png", "image/webp", "image/gif")) {
            assertNull(KinPhotoPolicy.validate(image(mime = mime)), "expected $mime to pass")
        }
    }

    @Test
    fun mimeCheckIsCaseInsensitive() {
        assertNull(KinPhotoPolicy.validate(image(mime = "IMAGE/JPEG")))
    }

    @Test
    fun rejectsEmptyFile() {
        assertNotNull(KinPhotoPolicy.validate(image(bytes = ByteArray(0))))
    }

    @Test
    fun rejectsOversizeFile() {
        val oversize = ByteArray(KinPhotoPolicy.MAX_BYTES + 1)
        val problem = KinPhotoPolicy.validate(image(bytes = oversize))
        assertNotNull(problem)
        assertTrue(problem.contains("10MB"), "oversize message should name the cap: $problem")
    }

    @Test
    fun acceptsExactlyMaxBytes() {
        assertNull(KinPhotoPolicy.validate(image(bytes = ByteArray(KinPhotoPolicy.MAX_BYTES))))
    }

    @Test
    fun rejectsNonImageMime() {
        assertNotNull(KinPhotoPolicy.validate(image(mime = "text/html")))
        assertNotNull(KinPhotoPolicy.validate(image(mime = "application/octet-stream")))
        assertNotNull(KinPhotoPolicy.validate(image(mime = "")))
    }

    @Test
    fun sanitizeFileNameDropsDirectoriesAndUnsafeChars() {
        assertEquals("passwd", KinPhotoPolicy.sanitizeFileName("../../etc/passwd"))
        assertEquals("c__windows_x.png", KinPhotoPolicy.sanitizeFileName("c:\\windows\\c__windows_x.png"))
        assertEquals("Buddy_the_Aussie_.jpg", KinPhotoPolicy.sanitizeFileName("Buddy the Aussie!.jpg"))
    }

    @Test
    fun sanitizeFileNameTrimsLeadingDotsAndCapsLength() {
        assertEquals("hidden", KinPhotoPolicy.sanitizeFileName(".hidden"))
        assertEquals(80, KinPhotoPolicy.sanitizeFileName("a".repeat(300) + ".jpg").length)
        assertEquals("photo", KinPhotoPolicy.sanitizeFileName(""))
        assertEquals("photo", KinPhotoPolicy.sanitizeFileName("..."))
    }
}
