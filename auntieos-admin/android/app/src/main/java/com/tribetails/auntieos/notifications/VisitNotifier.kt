package com.tribetails.auntieos.notifications

import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.ListenerRegistration
import com.google.firebase.functions.FirebaseFunctions
import com.tribetails.auntieos.data.model.KinCareSession
import com.tribetails.auntieos.data.repository.awaitCallable
import com.tribetails.auntieos.util.AuntieLog
import com.tribetails.auntieos.util.rethrowIfCancellation
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.coroutines.resume

/**
 * Dispatches visit-lifecycle notifications via the MyTribe catalog-driven
 * notification system (Firebase Functions callable `dispatchVisitNotification`).
 *
 * The catalog + per-kinfolk prefs decide which channels actually fire
 * (email / SMS / push). Templates own the copy. The Auntie app only declares
 * the lifecycle event.
 *
 * #2037: THE THREE CLOCK STEPS ARE NO LONGER SENT FROM HERE. The server sends
 * On my way, Arrived and Departed from the committed session write
 * (`functions/src/triggers/onKinCareSessionLifecycle.ts`), so a step held in
 * the offline queue, or an app closed right after the tap, still reaches the
 * household. [awaitStepNotice] reads the server's record of what the household
 * was told. [notify] stays for a KinTale (`REPORT_SENT`), which the app sends
 * itself.
 *
 * Previously this routed through SOTU's `sendMessage` HTTP → n8n proxy with
 * hardcoded body strings and a single hardcoded channel - that bypassed the
 * catalog, kinfolk prefs, multi-channel delivery, and templating. Migrated
 * 2026-05-11. The legacy SOTU `sendMessage` endpoint remains live for
 * free-form Auntie-authored messages (MessagingScreen, InboxViewModel).
 */
class VisitNotifier(
    private val functions: FirebaseFunctions = FirebaseFunctions.getInstance("us-central1"),
    private val firestore: () -> FirebaseFirestore = { FirebaseFirestore.getInstance() },
) {

    enum class Event(val wire: String) {
        ON_MY_WAY("on_my_way"),
        ARRIVED("arrived"),
        DEPARTED("departed"),
        REPORT_SENT("report_sent"),
    }

    /**
     * @param reason #1794: why nobody was told, by name, when [suppressed]
     *   (`household_has_no_portal_account`, `household_notices_off`,
     *   `household_prefs_suppressed`, `already_notified`). Null when someone was
     *   told, and from a server that predates the field.
     */
    data class DispatchResult(val dispatchIds: List<String>, val suppressed: Boolean, val reason: String? = null)

    /**
     * #1840: what `previewVisitNotification` answered for one household.
     * [reason] is `household_has_no_portal_account` or `household_notices_off`
     * when [willNotify] is false.
     */
    data class PreviewResult(val willNotify: Boolean, val reason: String? = null)

    /**
     * #1840: ask the server whether a visit notice can reach this household,
     * with the same two checks the dispatch makes (a member login to send to,
     * and the household-notices switch). Read-only.
     *
     * The confirm used to guess this from `kinfolk.uid` on the roster, which on
     * an unclaimed household held the Admin's own login. A failure here (no
     * signal, or a server from before this callable) leaves the confirm saying
     * nothing about the household.
     */
    suspend fun preview(familyId: String): Result<PreviewResult> = runCatching {
        if (familyId.isBlank()) error("VisitNotifier: familyId is blank - nothing to preview")
        @Suppress("UNCHECKED_CAST")
        val raw = functions
            .getHttpsCallable("previewVisitNotification")
            .call(mapOf("familyId" to familyId))
            .awaitCallable()
            .data as? Map<String, Any?>
            ?: error("VisitNotifier: preview returned non-map payload")
        val willNotify = raw["willNotify"] as? Boolean ?: error("VisitNotifier: preview carried no answer")
        PreviewResult(willNotify = willNotify, reason = (raw["reason"] as? String)?.takeIf { it.isNotBlank() })
    }.onFailure { AuntieLog.e("VisitNotifier: preview failed", it) }

    companion object {
        /** The stamped ISO instant as epoch millis, or null when absent or unparseable (never a guess). */
        fun epochMillisOrNull(iso: String?): Long? =
            iso?.takeIf { it.isNotBlank() }?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() }

        /** #2037: how long a card waits for the server's record before it says it is still checking. */
        const val VISIT_NOTICE_WAIT_MS: Long = 30_000L

        /** Where the server records what the household was told about one clock step. */
        const val VISIT_STEP_NOTICES_COLLECTION = "visit_step_notices"

        /**
         * #2037: the id of one step's record: the session, the notice and the
         * stamped time. The server builds the same string
         * (`functions/src/lib/visitStepNotice.ts#visitStepNoticeId`), and so do
         * web and the desktop console.
         */
        fun stepNoticeId(sessionId: String, event: Event, atMs: Long): String = "${sessionId}__${event.wire}__$atMs"

        /** PURE. The server's record of one step, in the shape [notify] answers. */
        fun stepRecordResult(notified: Boolean?, reason: String?): DispatchResult =
            if (notified == true) {
                DispatchResult(emptyList(), suppressed = false)
            } else {
                DispatchResult(emptyList(), suppressed = true, reason = reason?.takeIf { it.isNotBlank() } ?: "not_sent")
            }

        /** What [awaitStepNotice] answers when no record arrived in time. Never "not told". */
        val STILL_CHECKING = DispatchResult(emptyList(), suppressed = true, reason = "notice_pending")
    }

    /**
     * #2037: what the household was told about one clock step, as the SERVER
     * recorded it at `visit_step_notices/{id}`.
     *
     * The server sends the notice from the committed write, so nothing here can
     * lose it: this only waits up to [waitMs] for the record, for the sentence
     * on the card. No record in time, or a read that fails, answers
     * [STILL_CHECKING]. Never fails.
     *
     * @param eventAtIso the `onMyWayAt` / `arrivedAt` / `departedAt` the caller
     *   just wrote. With the session id and the step it names the record.
     */
    suspend fun awaitStepNotice(
        sessionId: String,
        event: Event,
        eventAtIso: String?,
        waitMs: Long = VISIT_NOTICE_WAIT_MS,
    ): Result<DispatchResult> {
        val atMs = epochMillisOrNull(eventAtIso) ?: return Result.success(STILL_CHECKING)
        val id = stepNoticeId(sessionId, event, atMs)
        val read = try {
            withTimeoutOrNull(waitMs) {
                suspendCancellableCoroutine<DispatchResult> { cont ->
                    var registration: ListenerRegistration? = null
                    registration = firestore().collection(VISIT_STEP_NOTICES_COLLECTION).document(id)
                        .addSnapshotListener { snap, err ->
                            if (!cont.isActive) return@addSnapshotListener
                            if (err != null) {
                                AuntieLog.e("VisitNotifier: could not read what the household was told", err)
                                registration?.remove()
                                cont.resume(STILL_CHECKING)
                                return@addSnapshotListener
                            }
                            if (snap == null || !snap.exists()) return@addSnapshotListener
                            registration?.remove()
                            cont.resume(stepRecordResult(snap.getBoolean("notified"), snap.getString("reason")))
                        }
                    cont.invokeOnCancellation { registration?.remove() }
                }
            }
        } catch (e: Exception) {
            e.rethrowIfCancellation()
            AuntieLog.e("VisitNotifier: could not read what the household was told", e)
            null
        }
        return Result.success(read ?: STILL_CHECKING)
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
        val reason = (raw["reason"] as? String)?.takeIf { it.isNotBlank() }
        DispatchResult(dispatchIds = dispatchIds, suppressed = suppressed, reason = reason)
    }.onFailure { AuntieLog.e("VisitNotifier: dispatch ${event.wire} failed", it) }
}
