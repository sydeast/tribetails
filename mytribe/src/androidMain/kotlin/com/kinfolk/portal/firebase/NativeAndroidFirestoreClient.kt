package com.kinfolk.portal.firebase

import com.google.firebase.Timestamp
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.MetadataChanges
import com.google.firebase.firestore.Query
import com.kinfolk.portal.components.RoutePoint
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.tasks.await

/**
 * #1282: document reads on Android go through the native Firestore SDK.
 *
 * The gitlive path (`GitliveFirestoreClient`) decodes a document with
 * `doc.data()` into `Map<String, Any?>`, and gitlive 2.x resolves a
 * kotlinx-serialization serializer for that type. There is none for `Any`,
 * which is the same `Serializer for class 'Any' is not found` failure that
 * moved callables to `NativeAndroidFunctionsClient`. Neither `getDocument` nor
 * `listDocuments` had a caller before #1282, which is how that went unnoticed.
 * The native SDK hands back plain `Map<String, Any>` with no serializer layer.
 *
 * Values arrive as the native SDK types them: `Long` for integers, `Double`,
 * `String`, `Boolean`, `List`, `Map`, and `Timestamp`. A `Timestamp` is turned
 * into epoch millis here so common code never sees an Android class.
 *
 * Live tracking is unchanged: `breadcrumbsStream` still goes through gitlive,
 * which is what it has always shipped on. The bell's listener (#1833) is native.
 */
class NativeAndroidFirestoreClient(
    private val streams: FirestoreClient = GitliveFirestoreClient(),
) : FirestoreClient {
    private val db get() = FirebaseFirestore.getInstance()

    override suspend fun getDocument(collection: String, documentId: String): Map<String, Any?>? {
        val snap = db.collection(collection).document(documentId).get().await()
        if (!snap.exists()) return null
        return normalise(snap.data ?: emptyMap())
    }

    override suspend fun listDocuments(collection: String): List<FirestoreDoc> {
        val snap = db.collection(collection).get().await()
        return snap.documents.map { doc -> FirestoreDoc(id = doc.id, fields = normalise(doc.data ?: emptyMap())) }
    }

    override fun breadcrumbsStream(sessionId: String): Flow<List<RoutePoint>> =
        streams.breadcrumbsStream(sessionId)

    /**
     * #1833: the bell's listener. Native for the same reason the document reads
     * above are: the rows are decoded as plain maps, which gitlive cannot do on
     * Android. The query is the one `firestore.rules` admits (own
     * `recipientUid`) on the index the server's count already uses.
     *
     * #2329: metadata changes are listened to as well, so the server's first
     * answer is seen even when it agrees with the cache, and each snapshot
     * says whether it came from the cache.
     */
    override fun recipientNotificationsStream(recipientUid: String, limit: Int): Flow<NotificationsSnapshot> {
        require(recipientUid.isNotBlank()) { "recipientNotificationsStream requires a non-blank recipientUid" }
        return callbackFlow {
            val registration = db.collection("notifications")
                .whereEqualTo("recipientUid", recipientUid)
                .orderBy("createdAt", Query.Direction.DESCENDING)
                .limit(limit.toLong())
                .addSnapshotListener(MetadataChanges.INCLUDE) { snap, error ->
                    if (error != null) {
                        close(error)
                    } else if (snap != null) {
                        trySend(
                            NotificationsSnapshot(
                                docs = snap.documents.map { doc -> FirestoreDoc(id = doc.id, fields = normalise(doc.data ?: emptyMap())) },
                                fromCache = snap.metadata.isFromCache,
                            ),
                        )
                    }
                }
            awaitClose { registration.remove() }
        }
    }
    private fun normalise(fields: Map<String, Any?>): Map<String, Any?> = fields.mapValues { (_, v) -> value(v) }

    private fun value(v: Any?): Any? = when (v) {
        is Timestamp -> v.toDate().time
        is Map<*, *> -> v.entries.associate { (k, inner) -> k.toString() to value(inner) }
        is List<*> -> v.map { value(it) }
        else -> v
    }
}
