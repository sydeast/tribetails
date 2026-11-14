package com.kinfolk.portal.firebase

import com.kinfolk.portal.components.RoutePoint
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow

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
    /**
     * #1833: live snapshots of the signed-in person's own newest
     * `notifications` rows (`recipientUid == recipientUid`, newest first, at
     * most [limit]), for the bell's unread count. A snapshot is emitted on
     * every change: a notice arriving, one being read or marked unread, one
     * being archived. A refused or broken listen fails the flow.
     *
     * `firestore.rules` admits this read for the recipient only, and only as a
     * query carrying the `recipientUid` filter; nobody writes from a client.
     *
     * The Android app implements it (NativeAndroidFirestoreClient). A client
     * with no live listener, which today is the desktop REST build and the
     * Kotlin/JS reference build, emits nothing: its bell keeps the count the
     * app opened with, as it did before.
     */
    fun recipientNotificationsStream(recipientUid: String, limit: Int): Flow<List<FirestoreDoc>> = emptyFlow()
}

data class FirestoreDoc(
    val id: String,
    val fields: Map<String, Any?>,
)
