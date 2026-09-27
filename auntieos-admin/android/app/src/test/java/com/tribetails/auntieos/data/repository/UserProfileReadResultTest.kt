package com.tribetails.auntieos.data.repository

import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.DocumentSnapshot
import com.google.firebase.firestore.EventListener
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.ListenerRegistration
import com.tribetails.auntieos.data.api.N8nApi
import com.tribetails.auntieos.data.model.UserProfile
import io.mockk.every
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * #897: the profile read a SAVING screen uses must tell "the read failed" apart
 * from "there is no document". `observeUserProfile` sends null for both, and a
 * null baseline is `saveUserProfile`'s create path, a whole-model write.
 */
class UserProfileReadResultTest {

    private val firestore = mockk<FirebaseFirestore>()
    private val collection = mockk<CollectionReference>()
    private val docRef = mockk<DocumentReference>()
    private val listener = slot<EventListener<DocumentSnapshot>>()

    private fun repo(): AuntieRepository {
        every { firestore.collection("users") } returns collection
        every { collection.document("u1") } returns docRef
        every { docRef.addSnapshotListener(capture(listener)) } returns mockk<ListenerRegistration>(relaxed = true)
        return AuntieRepository(
            n8n = mockk<N8nApi>(),
            authGate = mockk(relaxed = true),
            functionsOverride = mockk(),
            firestoreProvider = { firestore },
        )
    }

    private fun firstAnswer(deliver: () -> Unit): Result<UserProfile?> = runBlocking {
        val flow = repo().observeUserProfileResult("u1")
        // The listener is registered when collection starts; answer once it is.
        val job = async { flow.first() }
        while (!listener.isCaptured) yield()
        deliver()
        job.await()
    }

    @Test
    fun `a listener error is a failure, not a missing document`() {
        val err = mockk<FirebaseFirestoreException>(relaxed = true)
        val result = firstAnswer { listener.captured.onEvent(null, err) }
        assertTrue(result.isFailure)
    }

    @Test
    fun `a missing document is a success holding null`() {
        val snap = mockk<DocumentSnapshot>()
        every { snap.toObject(UserProfile::class.java) } returns null
        val result = firstAnswer { listener.captured.onEvent(snap, null) }
        assertTrue(result.isSuccess)
        assertNull(result.getOrNull())
    }

    @Test
    fun `a stored document is a success holding the profile`() {
        val snap = mockk<DocumentSnapshot>()
        every { snap.toObject(UserProfile::class.java) } returns UserProfile(uid = "u1", phone = "555-0100")
        val result = firstAnswer { listener.captured.onEvent(snap, null) }
        assertEquals("555-0100", result.getOrThrow()?.phone)
    }
}
