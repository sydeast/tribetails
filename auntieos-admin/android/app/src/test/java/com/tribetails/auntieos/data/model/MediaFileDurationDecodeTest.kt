package com.tribetails.auntieos.data.model

import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.util.CustomClassMapper
import io.mockk.mockk
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * #802. `durationSeconds` is a web-shaped `Int` field receiving a value web
 * can write as a NON-integer double (Cloudinary reports fractional seconds --
 * see `mediaUpload.test.ts`'s `durationSeconds: 12.5` / `9.2` fixtures).
 *
 * This is the one test in the #802 set that exercises the REAL Firestore
 * decoder (`CustomClassMapper`, the same code `toObjects(MediaFile::class.java)`
 * calls in `getMediaFiles`/`getAllMedia`) rather than a hand-rolled reflection
 * mimic, because the thing worth proving is not "the field exists" but "a
 * fractional web value decodes without throwing." A throw here would not
 * just miss the duration badge -- per `ModelNullSafetyDecodeTest`'s own
 * history, a single bad field on ONE document blanks the WHOLE query
 * (`toObjects` fails atomically), which would turn "no duration shown" into
 * "no gallery shown" for every admin with one web-uploaded video. Confirmed
 * safe by reading `CustomClassMapper.convertInteger`'s bytecode: a `Double`
 * source is narrowed via `Number.intValue()` (truncation), with no
 * precision-loss check (unlike `convertDouble`'s Long path, which does throw
 * on precision loss) -- these tests pin that behavior against the real
 * dependency so a future Firestore SDK bump cannot silently change it.
 */
class MediaFileDurationDecodeTest {

    private val noopDocRef = mockk<DocumentReference>(relaxed = true)

    @Test
    fun `a fractional Cloudinary duration truncates to whole seconds, never throws`() {
        val raw = mapOf("fileType" to "VIDEO", "durationSeconds" to 12.5)
        val decoded = CustomClassMapper.convertToCustomClass(raw, MediaFile::class.java, noopDocRef)
        assertEquals(12, decoded.durationSeconds)
    }

    @Test
    fun `a whole-number duration decodes exactly`() {
        val raw = mapOf("fileType" to "VIDEO", "durationSeconds" to 75.0)
        val decoded = CustomClassMapper.convertToCustomClass(raw, MediaFile::class.java, noopDocRef)
        assertEquals(75, decoded.durationSeconds)
    }

    @Test
    fun `a doc with no durationSeconds at all -- every video uploaded before #802 -- decodes to the zero default`() {
        val raw = mapOf("fileType" to "VIDEO")
        val decoded = CustomClassMapper.convertToCustomClass(raw, MediaFile::class.java, noopDocRef)
        assertEquals(0, decoded.durationSeconds)
    }

    @Test
    fun `a photo's absent duration is also just the zero default, never a decode failure`() {
        val raw = mapOf("fileType" to "IMAGE")
        val decoded = CustomClassMapper.convertToCustomClass(raw, MediaFile::class.java, noopDocRef)
        assertEquals(0, decoded.durationSeconds)
    }
}
