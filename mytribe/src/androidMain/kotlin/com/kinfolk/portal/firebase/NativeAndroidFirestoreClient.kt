package com.kinfolk.portal.firebase

import com.google.firebase.Timestamp
import com.google.firebase.firestore.FirebaseFirestore
import com.kinfolk.portal.components.RoutePoint
import kotlinx.coroutines.flow.Flow
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
 * which is what it has always shipped on.
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

    private fun normalise(fields: Map<String, Any?>): Map<String, Any?> = fields.mapValues { (_, v) -> value(v) }

    private fun value(v: Any?): Any? = when (v) {
        is Timestamp -> v.toDate().time
        is Map<*, *> -> v.entries.associate { (k, inner) -> k.toString() to value(inner) }
        is List<*> -> v.map { value(it) }
        else -> v
    }
}
