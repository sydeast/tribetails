package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FirebaseFirestore
import com.tribetails.auntieos.data.api.N8nApi
import com.tribetails.auntieos.data.model.MediaEntityType
import com.tribetails.auntieos.data.model.MediaFile
import com.tribetails.auntieos.data.model.MediaType
import com.tribetails.auntieos.domain.TestMode
import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #802. `MediaFile.durationSeconds` is a new top-level field, matching web's
 * `durationSeconds` field-for-field (see the field's own comment in
 * `data/model/DynamicFields.kt`). These tests pin how Android's two write
 * paths onto `media_files` carry it, mirroring `UserProfileMergeTest`'s
 * replay-the-real-write style:
 *
 *   - [AuntieRepository.saveMediaFile] only ever creates a BRAND-NEW document
 *     (`collection.document()`, no id, every call) and `set()`s the whole
 *     [MediaFile] object, so a field the model declares rides along
 *     automatically. This test proves it actually does for a real value, not
 *     just that the data class compiles.
 *   - [AuntieRepository.updateMediaFileDescription] is the one path that
 *     touches an EXISTING media doc, and it is a targeted single-key
 *     `.update("description", ...)` -- the diff-update shape this codebase's
 *     standing rule requires, not a `set()` rebuilt from screen state. This
 *     test proves the wire call carries only that one key, so it can never
 *     zero `durationSeconds` (or anything else) on an unrelated caption edit.
 */
class AuntieRepositoryMediaWriteTest {

    private val n8nApi = mockk<N8nApi>()
    private val firestore = mockk<FirebaseFirestore>()
    private val collection = mockk<CollectionReference>()
    private val docRef = mockk<DocumentReference>()

    private fun passingAuthGate(mode: TestMode = TestMode.OFF): AuthGate {
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } returns Unit
        coEvery { gate.requireTestMode() } returns mode
        return gate
    }

    private fun repo(gate: AuthGate = passingAuthGate()): AuntieRepository = AuntieRepository(
        n8n = n8nApi,
        authGate = gate,
        functionsOverride = mockk(),
        firestoreProvider = { firestore },
    )

    @Test
    fun `saveMediaFile writes durationSeconds on the brand-new doc`() = runBlocking {
        val setSlot = slot<MediaFile>()
        every { firestore.collection("media_files") } returns collection
        every { collection.document() } returns docRef
        every { docRef.id } returns "m-new"
        every { docRef.set(capture(setSlot)) } returns Tasks.forResult(null)
        // saveMediaFile's follow-up blank-field cleanup: harmless no-op here since
        // this doc's kinfolkId/gpsStripStatus are both real (non-blank).
        every { docRef.update(any<Map<String, Any>>()) } returns Tasks.forResult(null)

        val input = MediaFile(
            entityId = "kf1",
            entityType = MediaEntityType.KINFOLK.name,
            kinfolkId = "kf1",
            fileType = MediaType.VIDEO,
            durationSeconds = 75,
            gpsStripStatus = "PENDING",
        )

        val result = repo().saveMediaFile(input)

        assertTrue(result.isSuccess)
        assertEquals("m-new", result.getOrNull())
        assertEquals(75, setSlot.captured.durationSeconds)
    }

    @Test
    fun `saveMediaFile writes zero durationSeconds for a photo, never a fabricated value`() = runBlocking {
        val setSlot = slot<MediaFile>()
        every { firestore.collection("media_files") } returns collection
        every { collection.document() } returns docRef
        every { docRef.id } returns "m-new-2"
        every { docRef.set(capture(setSlot)) } returns Tasks.forResult(null)
        every { docRef.update(any<Map<String, Any>>()) } returns Tasks.forResult(null)

        val input = MediaFile(
            entityId = "kf1",
            entityType = MediaEntityType.KINFOLK.name,
            kinfolkId = "kf1",
            fileType = MediaType.IMAGE,
        )

        repo().saveMediaFile(input)

        assertEquals(0, setSlot.captured.durationSeconds)
    }

    @Test
    fun `updateMediaFileDescription writes ONLY description, never durationSeconds`() = runBlocking {
        val fieldSlot = slot<String>()
        val valueSlot = slot<Any>()
        every { firestore.collection("media_files") } returns collection
        every { collection.document("m1") } returns docRef
        every { docRef.update(capture(fieldSlot), capture(valueSlot)) } returns Tasks.forResult(null)

        val result = repo().updateMediaFileDescription("m1", "Zoomies in the yard")

        assertTrue(result.isSuccess)
        assertEquals("description", fieldSlot.captured)
        assertEquals("Zoomies in the yard", valueSlot.captured)
    }
}
