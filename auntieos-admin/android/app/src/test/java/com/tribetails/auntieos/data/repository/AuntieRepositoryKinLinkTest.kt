package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import com.tribetails.auntieos.data.api.N8nApi
import com.tribetails.auntieos.data.model.Kin
import com.tribetails.auntieos.domain.TestMode
import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #2115, #2290: admin Android never writes `familyKinPath`, the link from a Kin
 * to the household's copy of it.
 *
 * This file used to be `FamilyKinPathStampTest`, the tests of the function that
 * decided when the app should write that link. #2115 narrowed it to "only when
 * the Kin has none". #2290 is that last case going wrong: a Kin just made here
 * has no link for a moment, while the server ties it to the Kin the household
 * already added under the same name. The app's own link, `families/{kinfolkId}/
 * kin/{this id}`, named a copy nobody had made. Whichever write the server saw
 * first, it ended with a second household copy of the one Kin.
 *
 * So the function is gone, and these pin the wire instead: an add is ONE write,
 * a save is ONE write, and neither carries a link.
 */
class AuntieRepositoryKinLinkTest {

    private val firestore = mockk<FirebaseFirestore>()
    private val collection = mockk<CollectionReference>()
    private val docRef = mockk<DocumentReference>()

    /** Every write made to a `kin/{id}` document after the add: id to payload. */
    private val documentWrites = mutableListOf<Pair<String, Map<*, *>>>()

    private fun repo(): AuntieRepository {
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } returns Unit
        coEvery { gate.requireTestMode() } returns TestMode.OFF
        every { firestore.collection("kin") } returns collection
        every { collection.document(any()) } answers {
            val id = firstArg<String>()
            val ref = mockk<DocumentReference>()
            every { ref.set(any(), any<SetOptions>()) } answers {
                documentWrites += id to (firstArg<Any>() as Map<*, *>)
                Tasks.forResult<Void>(null)
            }
            ref
        }
        return AuntieRepository(
            n8n = mockk<N8nApi>(),
            authGate = gate,
            functionsOverride = mockk(), // lazy; never resolved on a write path
            firestoreProvider = { firestore },
        )
    }

    @Test
    fun `adding a Kin is one write, and nothing follows it`() = runBlocking {
        val added = slot<Kin>()
        every { collection.add(capture(added)) } returns Tasks.forResult(docRef)
        every { docRef.id } returns "k-new"

        val result = repo().createKin(Kin(kinfolkId = "kf1", name = "Biscuit", species = "Dog"))

        assertTrue(result.isSuccess)
        assertEquals("k-new", result.getOrNull()?.id)
        // The follow-up write of `families/kf1/kin/k-new` was the defect.
        assertEquals(emptyList<Pair<String, Map<*, *>>>(), documentWrites)
    }

    @Test
    fun `a new Kin goes up with no link, so the server looks for the household's copy`() = runBlocking {
        val added = slot<Kin>()
        every { collection.add(capture(added)) } returns Tasks.forResult(docRef)
        every { docRef.id } returns "k-new"

        repo().createKin(Kin(kinfolkId = "kf1", name = "Biscuit", species = "Dog"))

        assertEquals("", added.captured.familyKinPath)
        assertEquals("kf1", added.captured.kinfolkId)
        assertEquals("Biscuit", added.captured.name)
    }

    @Test
    fun `an add that fails reports the failure and writes nothing else`() = runBlocking {
        every { collection.add(any()) } returns Tasks.forException<DocumentReference>(RuntimeException("PERMISSION_DENIED"))

        val result = repo().createKin(Kin(kinfolkId = "kf1", name = "Biscuit"))

        assertTrue(result.isFailure)
        assertEquals(emptyList<Pair<String, Map<*, *>>>(), documentWrites)
    }

    @Test
    fun `saving a Kin is one merge of the changed fields and the stamp, with no link and no household`() = runBlocking {
        val result = repo().updateKinFields("k1", mapOf("weight" to "45 lbs"))

        assertTrue(result.isSuccess)
        assertEquals(1, documentWrites.size)
        val (id, payload) = documentWrites.single()
        assertEquals("k1", id)
        assertEquals(setOf("weight", "updatedAt"), payload.keys.map { it.toString() }.toSet())
        assertFalse(payload.containsKey("familyKinPath"))
        assertFalse(payload.containsKey("kinfolkId"))
    }

    @Test
    fun `a save with no changed field, or no record id, is refused and nothing is written`() = runBlocking {
        assertTrue(repo().updateKinFields("k1", emptyMap()).isFailure)
        assertTrue(repo().updateKinFields("", mapOf("weight" to "45 lbs")).isFailure)
        assertEquals(emptyList<Pair<String, Map<*, *>>>(), documentWrites)
    }
}
