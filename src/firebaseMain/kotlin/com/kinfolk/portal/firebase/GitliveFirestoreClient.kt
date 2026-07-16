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
                    .map { doc ->
                        @Suppress("UNCHECKED_CAST")
                        val data = (doc.data() as? Map<String, Any?>) ?: emptyMap()
                        val lat = (data["lat"] as? Number)?.toDouble() ?: 0.0
                        val lng = (data["lng"] as? Number)?.toDouble() ?: 0.0
                        val timestamp = data["timestamp"] as? String ?: ""
                        RoutePoint(lat = lat, lng = lng, t = parseIsoMs(timestamp))
                    }
                    // Server-side ordering by timestamp would need an index — sort client-side instead.
                    .sortedBy { it.t ?: 0L }
            }
    }
}

/** Slim ISO-8601 → epoch ms. Returns null on parse failure. */
private fun parseIsoMs(iso: String): Long? = runCatching {
    if (iso.length < 19) return@runCatching null
    val y  = iso.substring(0, 4).toInt()
    val mo = iso.substring(5, 7).toInt()
    val d  = iso.substring(8, 10).toInt()
    val h  = iso.substring(11, 13).toInt()
    val mi = iso.substring(14, 16).toInt()
    val s  = iso.substring(17, 19).toInt()
    daysFromCivil(y, mo, d) * 86_400_000L + h * 3_600_000L + mi * 60_000L + s * 1_000L
}.getOrNull()

private fun daysFromCivil(y: Int, m: Int, d: Int): Long {
    val yy = if (m <= 2) y - 1 else y
    val era = if (yy >= 0) yy / 400 else (yy - 399) / 400
    val yoe = (yy - era * 400).toLong()
    val mp = if (m > 2) m - 3 else m + 9
    val doy = (153 * mp + 2) / 5 + d - 1
    val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    return era * 146_097L + doe - 719_468L
}
