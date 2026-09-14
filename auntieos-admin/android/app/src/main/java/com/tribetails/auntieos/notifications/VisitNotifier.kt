package com.tribetails.auntieos.notifications

import com.google.firebase.functions.FirebaseFunctions
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.repository.awaitCallable
import com.tribetails.auntieos.util.AuntieLog

/**
 * Dispatches visit-lifecycle notifications via the MyTribe catalog-driven
 * notification system (Firebase Functions callable `dispatchVisitNotification`).
 *
 * The catalog + per-kinfolk prefs decide which channels actually fire
 * (email / SMS / push). Templates own the copy. The Auntie app only declares
 * the lifecycle event.
 *
 * Previously this routed through SOTU's `sendMessage` HTTP → n8n proxy with
 * hardcoded body strings and a single hardcoded channel - that bypassed the
 * catalog, kinfolk prefs, multi-channel delivery, and templating. Migrated
 * 2026-05-11. The legacy SOTU `sendMessage` endpoint remains live for
 * free-form Auntie-authored messages (MessagingScreen, InboxViewModel).
 */
class VisitNotifier(
    private val functions: FirebaseFunctions = FirebaseFunctions.getInstance("us-central1"),
) {

    enum class Event(val wire: String) {
        ON_MY_WAY("on_my_way"),
        ARRIVED("arrived"),
        DEPARTED("departed"),
        REPORT_SENT("report_sent"),
    }

    data class DispatchResult(val dispatchIds: List<String>, val suppressed: Boolean)

    companion object {
        /** The stamped ISO instant as epoch millis, or null when absent or unparseable (never a guess). */
        fun epochMillisOrNull(iso: String?): Long? =
            iso?.takeIf { it.isNotBlank() }?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() }
    }

    /**
     * @param eventAtIso the `onMyWayAt` / `arrivedAt` / `departedAt` the caller
     *   just wrote. Sent as `eventAtMs`: the server names the household
     *   notification by it, so a re-arrival after an undo is a new message and a
     *   retry of one tap is not (#832).
     * @param reportId the KinTale a REPORT_SENT announces, for the same reason:
     *   two reports for one visit are two notifications.
     */
    suspend fun notify(
        event: Event,
        session: KinCareSession,
        etaMinutes: Int = 0,
        reportPreviewUrl: String? = null,
        eventAtIso: String? = null,
        reportId: String? = null,
    ): Result<DispatchResult> = runCatching {
        val familyId = session.kinfolkId.ifBlank {
            error("VisitNotifier: session.kinfolkId is blank - cannot route notification")
        }

        // Prefer the MyTribe booking-envelope IDs (batchId + visitId) when present.
        // The server callable accepts either form. Fall back to sourceBookingId for
        // AuntieOS-native sessions that predate the kinCare envelope.
        val batchId = session.kinCareBatchId?.takeIf { it.isNotBlank() }
        val visitId = session.kinCareVisitId?.takeIf { it.isNotBlank() }
        val bookingId = session.sourceBookingId.takeIf { it.isNotBlank() }

        val useEnvelopeIds = batchId != null && visitId != null

        if (!useEnvelopeIds && bookingId == null) {
            error("VisitNotifier: session has neither kinCareBatchId+kinCareVisitId nor sourceBookingId — cannot route notification")
        }

        val payload = buildMap<String, Any> {
            put("familyId", familyId)
            if (useEnvelopeIds) {
                put("batchId", batchId!!)
                put("visitId", visitId!!)
            } else {
                put("bookingId", bookingId!!)
            }
            put("event", event.wire)
            if (etaMinutes > 0) put("etaMinutes", etaMinutes)
            if (!reportPreviewUrl.isNullOrBlank()) put("reportPreviewUrl", reportPreviewUrl)
            epochMillisOrNull(eventAtIso)?.let { put("eventAtMs", it) }
            if (!reportId.isNullOrBlank()) put("reportId", reportId)
        }

        val routingDesc = if (useEnvelopeIds) "batch=$batchId visit=$visitId" else "booking=$bookingId"
        AuntieLog.i("VisitNotifier: dispatch ${event.wire} family=$familyId $routingDesc")

        @Suppress("UNCHECKED_CAST")
        val raw = functions
            .getHttpsCallable("dispatchVisitNotification")
            .call(payload)
            .awaitCallable()
            .data as? Map<String, Any?>
            ?: error("VisitNotifier: callable returned non-map payload")

        val dispatchIds = (raw["dispatchIds"] as? List<*>)?.mapNotNull { it as? String } ?: emptyList()
        val suppressed = (raw["suppressed"] as? Boolean) ?: dispatchIds.isEmpty()
        DispatchResult(dispatchIds = dispatchIds, suppressed = suppressed)
    }.onFailure { AuntieLog.e("VisitNotifier: dispatch ${event.wire} failed", it) }
}
