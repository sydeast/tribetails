package com.kinfolk.portal.firebase

import com.kinfolk.portal.components.RoutePoint
import kotlinx.coroutines.flow.Flow

/**
 * Minimal cross-platform Firestore facade used by client UI.
 * Backed by gitlive on android/js and by REST on jvm.
 */
interface FirestoreClient {
    /** Returns null if document does not exist. */
    suspend fun getDocument(collection: String, documentId: String): Map<String, Any?>?

    /** Returns documents in a collection (no filter). Map of (id -> fields). */
    suspend fun listDocuments(collection: String): List<FirestoreDoc>

    /**
     * Live snapshot of `kin_care_sessions/{sessionId}/breadcrumbs`, sorted oldest→newest.
     * Used by the MyTribe Schedule screen to render a growing polyline while
     * the kinfolk's Auntie is mid-visit (status ARRIVED on AuntieOS side).
     * Firestore rules already gate access by parent-session kinfolkId.
     */
    fun breadcrumbsStream(sessionId: String): Flow<List<RoutePoint>>
}

data class FirestoreDoc(
    val id: String,
    val fields: Map<String, Any?>,
)
