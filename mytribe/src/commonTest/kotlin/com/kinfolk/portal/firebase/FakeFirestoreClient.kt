package com.kinfolk.portal.firebase

import com.kinfolk.portal.components.RoutePoint
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf

/**
 * No-op FirestoreClient for tests that need the dependency satisfied but
 * exercise only PortalApi-driven flows. Streams emit an empty list once and
 * complete; reads return empty / null. Tests that need real Firestore behavior
 * should build a tailored fake instead of reusing this.
 */
class FakeFirestoreClient : FirestoreClient {
    override suspend fun getDocument(collection: String, documentId: String): Map<String, Any?>? = null
    override suspend fun listDocuments(collection: String): List<FirestoreDoc> = emptyList()
    override fun breadcrumbsStream(sessionId: String): Flow<List<RoutePoint>> = flowOf(emptyList())
}
