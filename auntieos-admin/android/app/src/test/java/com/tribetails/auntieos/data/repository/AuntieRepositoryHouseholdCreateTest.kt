package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.SetOptions
import com.google.firebase.firestore.Transaction
import com.tribetails.auntieos.data.api.N8nApi
import com.tribetails.auntieos.data.model.HouseholdData
import com.tribetails.auntieos.ui.directory.householdCreateFields
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #2289: a household has ONE `household_data` record, whichever side makes it
 * first.
 *
 * The portal's first vet pick makes the record at `household_data/{householdId}`.
 * This app made its own under an auto id, as the whole model. An operator who
 * saved from a screen that loaded with no record, after the household had
 * picked a vet, made a second record; the two sides then read different ones.
 *
 * The write is replayed against a stored document with Firestore's real
 * semantics (`set(obj)` replaces, `set(map, merge())` overlays only the keys the
 * map carries), and the assertions are on what survives. Same shape as
 * `InboundCallLogUpsertTest`.
 *
 * What this cannot show: that two transactions do not interleave. That is
 * Firestore's, and it holds because both sides now write the same document.
 */
class AuntieRepositoryHouseholdCreateTest {

    private val firestore = mockk<FirebaseFirestore>()
    private val collection = mockk<CollectionReference>()
    private val transaction = mockk<Transaction>()
    private val snapshot = mockk<DocumentSnapshot>()

    private data class RecordedWrite(val docId: String, val payload: Any, val merge: Boolean, val inTransaction: Boolean)

    private val writes = mutableListOf<RecordedWrite>()
    private val documentIdsAsked = mutableListOf<String>()
    private var autoIdAsked = false

    private fun repo(recordExists: Boolean): AuntieRepository {
        val gate = mockk<AuthGate>()
        every { gate.ensureAuthenticated() } returns Unit
        every { firestore.collection("household_data") } returns collection
        // An auto id is the defect. It is answered, not left to throw, so the
        // test fails on the assertion that names it.
        every { collection.document() } answers {
            autoIdAsked = true
            docRef("auto-id")
        }
        every { collection.document(any()) } answers {
            documentIdsAsked += firstArg<String>()
            docRef(firstArg())
        }
        every { snapshot.exists() } returns recordExists
        every { transaction.get(any<DocumentReference>()) } returns snapshot
        every { transaction.set(any(), any(), any<SetOptions>()) } answers {
            writes += RecordedWrite(firstArg<DocumentReference>().id, secondArg(), merge = true, inTransaction = true)
            transaction
        }
        every { transaction.set(any(), any()) } answers {
            writes += RecordedWrite(firstArg<DocumentReference>().id, secondArg(), merge = false, inTransaction = true)
            transaction
        }
        every { firestore.runTransaction(any<Transaction.Function<Any?>>()) } answers {
            Tasks.forResult(firstArg<Transaction.Function<Any?>>().apply(transaction))
        }
        return AuntieRepository(
            n8n = mockk<N8nApi>(),
            authGate = gate,
            functionsOverride = mockk(), // lazy; never resolved on a write path
            firestoreProvider = { firestore },
        )
    }

    private fun docRef(id: String): DocumentReference {
        val ref = mockk<DocumentReference>()
        every { ref.id } returns id
        every { ref.set(any()) } answers {
            writes += RecordedWrite(id, firstArg(), merge = false, inTransaction = false)
            Tasks.forResult<Void>(null)
        }
        every { ref.set(any(), any<SetOptions>()) } answers {
            writes += RecordedWrite(id, firstArg(), merge = true, inTransaction = false)
            Tasks.forResult<Void>(null)
        }
        return ref
    }

    /** The one write, as a field map. A whole-model write fails here, by name. */
    private fun payload(): Map<String, Any?> {
        val write = writes.single()
        assertTrue("the first save must send a field map, not the whole model", write.payload is Map<*, *>)
        return (write.payload as Map<*, *>).entries.associate { it.key.toString() to it.value }
    }

    /** Replays the write against a stored document, as Firestore would. */
    private fun serverDocAfterWrite(stored: Map<String, Any?>): Map<String, Any?> {
        val write = writes.single()
        return if (write.merge) stored + payload() else payload()
    }

    private val form = HouseholdData(kinfolkId = "kf9", foodLocation = "pantry")

    @Test
    fun `the first record is made at the household's own id, never under an auto id`() = runBlocking {
        val result = repo(recordExists = false).saveHouseholdData(form)

        assertEquals("kf9", result.getOrNull())
        assertFalse("an auto id is how a household got a second record", autoIdAsked)
        assertEquals(listOf("kf9"), documentIdsAsked)
        assertEquals("kf9", writes.single().docId)
    }

    @Test
    fun `the write is a merge inside a transaction that read the record first`() = runBlocking {
        repo(recordExists = false).saveHouseholdData(form)

        val write = writes.single()
        assertTrue(write.merge)
        assertTrue(write.inTransaction)
    }

    @Test
    fun `only what was filled in is sent, with the household id and both stamps`() = runBlocking {
        repo(recordExists = false).saveHouseholdData(form)

        assertEquals(setOf("kinfolkId", "foodLocation", "createdAt", "updatedAt"), payload().keys)
        assertEquals("kf9", payload()["kinfolkId"])
        assertEquals("pantry", payload()["foodLocation"])
        assertTrue(payload()["createdAt"] is String)
        assertEquals(payload()["createdAt"], payload()["updatedAt"])
    }

    /** The issue's own sequence: the household picked its vet, then the office saved from a screen with no record. */
    @Test
    fun `the household picked a vet first - the save joins that record and the vet stands`() = runBlocking {
        val portalMade = mapOf<String, Any?>(
            "kinfolkId" to "kf9",
            "primaryVetClinicId" to "clinic_riverside",
            "createdAt" to "2026-11-20T09:00:00.000Z",
            "updatedAt" to "2026-11-20T09:00:00.000Z",
        )

        val result = repo(recordExists = true).saveHouseholdData(form)

        assertEquals("kf9", result.getOrNull())
        assertFalse(autoIdAsked)
        val after = serverDocAfterWrite(portalMade)
        assertEquals("clinic_riverside", after["primaryVetClinicId"])
        assertEquals("pantry", after["foodLocation"])
        assertEquals("the record's first date is the household's, not this save's", "2026-11-20T09:00:00.000Z", after["createdAt"])
        assertFalse(payload().containsKey("primaryVetClinicId"))
        assertFalse(payload().containsKey("createdAt"))
    }

    @Test
    fun `a vet the operator picked on the first save is sent`() = runBlocking {
        repo(recordExists = false).saveHouseholdData(form.copy(primaryVetClinicId = "clinic_oak"))
        assertEquals("clinic_oak", payload()["primaryVetClinicId"])
    }

    @Test
    fun `a record that already has an id is refused here and pointed at the edit path`() = runBlocking {
        val result = repo(recordExists = true).saveHouseholdData(form.copy(id = "hd1"))

        assertTrue(result.isFailure)
        assertTrue(result.exceptionOrNull()?.message.orEmpty().contains("updateHouseholdFields"))
        assertTrue(writes.isEmpty())
    }

    @Test
    fun `a form with no household is refused, and nothing is written`() = runBlocking {
        val result = repo(recordExists = false).saveHouseholdData(HouseholdData(foodLocation = "pantry"))

        assertTrue(result.isFailure)
        assertTrue(writes.isEmpty())
        assertTrue(documentIdsAsked.isEmpty())
    }

    @Test
    fun `a transaction the server refuses is a failed save`() = runBlocking {
        val repo = repo(recordExists = false)
        every { firestore.runTransaction(any<Transaction.Function<Any?>>()) } returns
            Tasks.forException<Any?>(RuntimeException("PERMISSION_DENIED"))

        val result = repo.saveHouseholdData(form)

        assertTrue(result.isFailure)
        assertNull(result.getOrNull())
    }

    // ── householdCreateFields, the map itself ────────────────────────────────

    @Test
    fun `a blank form sends the household id and the stamps, and no field at all`() {
        val fields = householdCreateFields(HouseholdData(kinfolkId = "kf9"), "2026-11-20T10:00:00Z", recordExists = false)
        assertEquals(
            mapOf("kinfolkId" to "kf9", "createdAt" to "2026-11-20T10:00:00Z", "updatedAt" to "2026-11-20T10:00:00Z"),
            fields,
        )
    }

    @Test
    fun `joining a record that is there never sends createdAt`() {
        val fields = householdCreateFields(form, "2026-11-20T10:00:00Z", recordExists = true)
        assertEquals(mapOf("kinfolkId" to "kf9", "foodLocation" to "pantry", "updatedAt" to "2026-11-20T10:00:00Z"), fields)
    }
}
