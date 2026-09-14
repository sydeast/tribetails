package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FirebaseFirestore
import com.tribetails.auntieos.data.api.N8nApi
import com.tribetails.auntieos.data.model.Kinfolk
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
 * #829 Fix round 1. `createKinfolkComplete` used to hand
 * `.add()` the whole [Kinfolk] POJO, which wrote `emergencyContacts: null`
 * and the three flat Emergency Contact keys blank on every new household -
 * a write no client may make, even an "empty" one (the plan's Global
 * Constraints: no client writes `kinfolk.emergencyContacts` or the flat
 * fields directly, ever). These tests capture the actual payload handed to
 * `.add()` and assert none of the four keys is present, while every other
 * field the create writes today still rides along.
 */
class AuntieRepositoryCreateKinfolkTest {

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

    private val excludedKeys = listOf(
        "emergencyContacts",
        "emergencyContactName",
        "emergencyContactPhone",
        "emergencyContactRelation",
    )

    @Test
    fun `createKinfolkComplete never writes the four Emergency Contact keys, and keeps every other field`() = runBlocking {
        val addSlot = slot<Any>()
        every { firestore.collection("kinfolk") } returns collection
        every { collection.add(capture(addSlot)) } returns Tasks.forResult(docRef)
        every { docRef.id } returns "kf-new"

        val input = Kinfolk(
            firstName = "Jamie",
            lastName = "Halbrook",
            phoneNumber = "5125550134",
            serviceAddress = "1 Bark Ave",
            internalNotes = "Referred by a neighbor",
        )

        val result = repo().createKinfolkComplete(input)

        assertTrue(result.isSuccess)
        assertEquals("kf-new", result.getOrNull()?.id)

        @Suppress("UNCHECKED_CAST")
        val payload = addSlot.captured as Map<String, Any?>
        for (key in excludedKeys) {
            assertFalse("$key must never be written by the client (#829)", payload.containsKey(key))
        }
        assertFalse("the document id is never part of the document's own content", payload.containsKey("id"))
        assertEquals("Jamie", payload["firstName"])
        assertEquals("Halbrook", payload["lastName"])
        assertEquals("5125550134", payload["phoneNumber"])
        assertEquals("1 Bark Ave", payload["serviceAddress"])
        assertEquals("Referred by a neighbor", payload["internalNotes"])
        assertEquals("active", payload["status"])
    }
}
