package com.kinfolk.portal.firebase

import com.kinfolk.portal.components.RoutePoint
import dev.gitlive.firebase.Firebase
import dev.gitlive.firebase.firestore.firestore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

class GitliveFirestoreClient : FirestoreClient {
    private val db get() = Firebase.firestore

    override suspend fun getDocument(collection: String, documentId: String): Map<String, Any?>? {
        val snap = db.collection(collection).document(documentId).get()
        if (!snap.exists) return null
        @Suppress("UNCHECKED_CAST")
        return (snap.data() as? Map<String, Any?>) ?: emptyMap()
    }

    override suspend fun listDocuments(collection: String): List<FirestoreDoc> {
        val snap = db.collection(collection).get()
        return snap.documents.map { doc ->
            @Suppress("UNCHECKED_CAST")
            val data = (doc.data() as? Map<String, Any?>) ?: emptyMap()
            FirestoreDoc(id = doc.id, fields = data)
        }
    }

    override fun breadcrumbsStream(sessionId: String): Flow<List<RoutePoint>> {
        require(sessionId.isNotBlank()) { "breadcrumbsStream requires a non-blank sessionId" }
        return db.collection("kin_care_sessions/$sessionId/breadcrumbs")
            .snapshots
            .map { snap ->
                snap.documents
                    .mapNotNull { doc ->
                        @Suppress("UNCHECKED_CAST")
                        val data = (doc.data() as? Map<String, Any?>) ?: emptyMap()
                        // Issue #607: both wire shapes, and a document with no
                        // usable pair is dropped rather than defaulted to 0,0.
                        decodeBreadcrumb(data)
                    }
                    // No server orderBy: it would need an index, and Firestore
                    // sorts a mixed-type field by type group, which would put
                    // every Android ping before every web one. See orderBreadcrumbs.
                    .let(::orderBreadcrumbs)
            }
    }
}
