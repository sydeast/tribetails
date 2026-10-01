package com.tribetails.auntieos.data.repository

import com.google.android.gms.tasks.Tasks
import com.google.firebase.Timestamp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.auth.FirebaseUser
import com.google.firebase.firestore.CollectionReference
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.firestore.QueryDocumentSnapshot
import com.google.firebase.firestore.QuerySnapshot
import com.tribetails.auntieos.data.api.N8nApi
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.util.Date

/**
 * #1065 (AUNTIEOS-ADMIN-1N): the real repository method, against the docs the
 * server actually writes. `createdAt`, `readAt` and `archivedAt` are all
 * `FieldValue.serverTimestamp()`, which the Android SDK hands back as a
 * [Timestamp]. The old `toObjects(NotificationEntry)` threw on that and the
 * whole inbox came back as a failure.
 */
class AuntieRepositoryGetNotificationsTest {

    private val iso = "2026-06-27T17:07:24.579Z"
    private val ts = Timestamp(Date.from(Instant.parse(iso)))

    private fun snap(id: String, data: Map<String, Any?>): QueryDocumentSnapshot {
        val d = mockk<QueryDocumentSnapshot>()
        every { d.id } returns id
        // Firestore declares the map non-null-valued, but a doc can hold explicit nulls.
        @Suppress("UNCHECKED_CAST")
        every { d.data } returns (data as Map<String, Any>)
        return d
    }

    private fun load(vararg docs: QueryDocumentSnapshot) = runBlocking {
        val firestore = mockk<FirebaseFirestore>()
        val collection = mockk<CollectionReference>()
        val query = mockk<Query>()
        val result = mockk<QuerySnapshot>()
        every { firestore.collection("notifications") } returns collection
        every { collection.whereEqualTo("recipientUid", "u1") } returns query
        every { query.get() } returns Tasks.forResult(result)
        every { result.documents } returns docs.toList()

        val user = mockk<FirebaseUser>()
        every { user.uid } returns "u1"
        val auth = mockk<FirebaseAuth>()
        every { auth.currentUser } returns user

        AuntieRepository(
            n8n = mockk<N8nApi>(),
            authGate = mockk(relaxed = true),
            functionsOverride = mockk(),
            firestoreProvider = { firestore },
            authProvider = { auth },
        ).getNotifications()
    }

    @Test
    fun `server-shaped Timestamp docs load as ISO rows, archived ones hidden`() {
        val result = load(
            snap("new", mapOf("key" to "invoice.new", "recipientUid" to "u1", "createdAt" to ts)),
            snap("read", mapOf("key" to "invoice.new", "recipientUid" to "u1", "createdAt" to ts, "readAt" to ts)),
            snap("filed", mapOf("key" to "invoice.new", "recipientUid" to "u1", "createdAt" to ts, "archivedAt" to ts)),
            snap("restored", mapOf("key" to "invoice.new", "recipientUid" to "u1", "createdAt" to iso, "archivedAt" to null)),
        )
        assertTrue(result.exceptionOrNull()?.toString(), result.isSuccess)
        val rows = result.getOrThrow()
        assertEquals(listOf("new", "read", "restored"), rows.map { it.id })
        assertEquals(listOf(iso, iso, iso), rows.map { it.createdAt })
        assertEquals(iso, rows[1].readAt)
    }

    @Test
    fun `one malformed createdAt does not fail the list`() {
        val result = load(
            snap("a", mapOf("key" to "k", "createdAt" to ts)),
            snap("b", mapOf("key" to "k", "createdAt" to mapOf("bogus" to true))),
            snap("c", mapOf("key" to "k", "createdAt" to Instant.parse(iso).toEpochMilli())),
        )
        val rows = result.getOrThrow()
        assertEquals(listOf("a", "b", "c"), rows.map { it.id })
        assertEquals(listOf(iso, "", iso), rows.map { it.createdAt })
    }
}
