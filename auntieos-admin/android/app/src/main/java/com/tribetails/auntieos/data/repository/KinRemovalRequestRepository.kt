package com.tribetails.auntieos.data.repository

import com.google.firebase.functions.FirebaseFunctions
import com.tribetails.auntieos.util.AuntieLog
import com.tribetails.auntieos.util.runCatchingCancellable

/**
 * #1408. One household request to remove a Kin that has history, as
 * `listKinRemovalRequests` / `resolveKinRemovalRequest` return it
 * (`mytribe/functions/src/admin/kinRemovalRequests.ts`). The React twin is
 * `KinRemovalRequestDto` in `src/api/kinRemovalRequests.ts`.
 */
data class KinRemovalRequestRow(
    val id: String,
    val kinfolkId: String,
    /** The household's own copy, `families/{kinfolkId}/kin/{kinId}`. */
    val kinId: String,
    /** The flat `kin/{id}` doc this app opens. */
    val flatKinId: String?,
    val kinName: String?,
    val reason: String?,
    /** `pending`, `archived` or `declined`. */
    val status: String,
    val requestedAtMs: Long?,
    val resolvedAtMs: Long?,
    val resolutionNote: String?,
)

/** What the server did with an answer. */
data class KinRemovalResolution(
    val decision: String,
    val request: KinRemovalRequestRow,
    val householdNotified: Boolean,
)

private fun Map<String, Any?>.text(key: String): String? = (this[key] as? String)?.takeIf { it.isNotEmpty() }
private fun Map<String, Any?>.millis(key: String): Long? = (this[key] as? Number)?.toLong()

/** Decodes one request row; null when the row has no id. */
internal fun decodeKinRemovalRequestRow(raw: Map<String, Any?>?): KinRemovalRequestRow? {
    if (raw == null) return null
    val id = raw.text("id") ?: return null
    return KinRemovalRequestRow(
        id = id,
        kinfolkId = raw.text("kinfolkId").orEmpty(),
        kinId = raw.text("kinId").orEmpty(),
        flatKinId = raw.text("flatKinId"),
        kinName = raw.text("kinName"),
        reason = raw.text("reason"),
        status = raw.text("status") ?: "pending",
        requestedAtMs = raw.millis("requestedAtMs"),
        resolvedAtMs = raw.millis("resolvedAtMs"),
        resolutionNote = raw.text("resolutionNote"),
    )
}

@Suppress("UNCHECKED_CAST")
internal fun decodeKinRemovalList(raw: Any?): List<KinRemovalRequestRow> {
    val list = (raw as? Map<String, Any?>)?.get("requests") as? List<*> ?: return emptyList()
    return list.mapNotNull { decodeKinRemovalRequestRow(it as? Map<String, Any?>) }
}

@Suppress("UNCHECKED_CAST")
internal fun decodeKinRemovalResolution(raw: Any?): KinRemovalResolution {
    val map = raw as? Map<String, Any?> ?: error("The answer was recorded, but the reply could not be read. Reload to see it.")
    val request = decodeKinRemovalRequestRow(map["request"] as? Map<String, Any?>)
        ?: error("The answer was recorded, but the reply could not be read. Reload to see it.")
    return KinRemovalResolution(
        decision = map["decision"] as? String ?: "",
        request = request,
        householdNotified = map["householdNotified"] as? Boolean == true,
    )
}

/**
 * The office's end of a household's request to remove a Kin with history.
 * Archive sets the Kin archived on both copies (nothing is deleted); decline
 * leaves it and tells the household. Owner only on the server: an Auntie is
 * refused, and that refusal is what this app shows her.
 */
open class KinRemovalRequestRepository(
    functionsProvider: () -> FirebaseFunctions = { FirebaseFunctions.getInstance("us-central1") },
) {
    /** Lazy for the reason `VisitRequestRepository` gives: view-model tests build it with no Firebase process. */
    private val functions: FirebaseFunctions by lazy(functionsProvider)

    /** Every pending request, oldest first; with [flatKinId], that Kin's only. */
    open suspend fun list(flatKinId: String? = null): Result<List<KinRemovalRequestRow>> =
        runCatchingCancellable {
            val payload = if (flatKinId != null) mapOf("flatKinId" to flatKinId) else emptyMap<String, Any>()
            val raw = functions.getHttpsCallable("listKinRemovalRequests")
                .call(payload)
                .awaitCallable().data
            decodeKinRemovalList(raw)
        }.onFailure { AuntieLog.e("KinRemovalRequestRepository.list failed", it) }

    /** [decision] is `archive` or `decline`; a blank note is not sent. */
    open suspend fun resolve(requestId: String, decision: String, note: String?): Result<KinRemovalResolution> =
        runCatchingCancellable {
            val payload = buildMap<String, Any> {
                put("requestId", requestId)
                put("decision", decision)
                note?.trim()?.takeIf { it.isNotEmpty() }?.let { put("note", it) }
            }
            val raw = functions.getHttpsCallable("resolveKinRemovalRequest")
                .call(payload)
                .awaitCallable().data
            decodeKinRemovalResolution(raw)
        }.onFailure { AuntieLog.e("KinRemovalRequestRepository.resolve failed", it) }
}
