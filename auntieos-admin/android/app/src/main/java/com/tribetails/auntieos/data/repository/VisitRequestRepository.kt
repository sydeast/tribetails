package com.tribetails.auntieos.data.repository

import com.google.firebase.functions.FirebaseFunctions
import com.tribetails.auntieos.data.contracts.CancelRequestDto
import com.tribetails.auntieos.data.contracts.ListCancelRequestsArgs
import com.tribetails.auntieos.data.contracts.ListRescheduleRequestsArgs
import com.tribetails.auntieos.data.contracts.RescheduleRequestDto
import com.tribetails.auntieos.data.contracts.ResolveBookingCancellationRequestArgs
import com.tribetails.auntieos.data.contracts.ResolveBookingCancellationRequestResult
import com.tribetails.auntieos.data.contracts.ResolveBookingRescheduleRequestArgs
import com.tribetails.auntieos.data.contracts.ResolveBookingRescheduleRequestResult
import com.tribetails.auntieos.data.contracts.decodeListCancelRequestsResult
import com.tribetails.auntieos.data.contracts.decodeListRescheduleRequestsResult
import com.tribetails.auntieos.data.contracts.decodeResolveBookingCancellationRequestResult
import com.tribetails.auntieos.data.contracts.decodeResolveBookingRescheduleRequestResult
import com.tribetails.auntieos.util.AuntieLog
import kotlinx.coroutines.tasks.await

/**
 * The office's end of the two things a household can ask for on a visit: a new
 * time (#399 item 2) and a cancellation (#438).
 *
 * BOTH arrive through callables rather than a Firestore query, and for the same
 * reason the React admin's `api/rescheduleRequests.ts` gives: the asks live one
 * per household under `families/{kinfolkId}/bookings/{batchId}/kinCares`, this
 * app's schedule reads the FLAT `kin_care_sessions` collection, and a
 * collection-group read across every household is a cross-tenant query this
 * client should not be issuing itself.
 *
 * The cancellation half is the one that had never been read at all. The flag
 * has been written to the visit since 2026-07-02 and no admin surface, web or
 * Android, ever looked at it, so a household could be told their request was
 * sent while an Auntie went on turning up.
 */
class VisitRequestRepository(
    functionsProvider: () -> FirebaseFunctions = { FirebaseFunctions.getInstance("us-central1") },
) {
    /**
     * LAZY, unlike the other repositories' eager `FirebaseFunctions` default.
     *
     * `EnhancedSchedulingViewModel` constructs this one itself when a caller
     * does not supply it, so an eager default would reach
     * `FirebaseApp.getInstance()` the moment that view model is built -- and
     * every existing view-model unit test builds it without a Firebase process.
     * Resolving on first CALL instead keeps construction free, and the calls
     * themselves are already inside `runCatching`.
     */
    private val functions: FirebaseFunctions by lazy(functionsProvider)

    /** Every visit with a proposed new time still waiting on a decision, oldest first. */
    suspend fun listRescheduleRequests(limit: Long? = null): Result<List<RescheduleRequestDto>> =
        runCatching {
            val raw = functions.getHttpsCallable("listRescheduleRequests")
                .call(ListRescheduleRequestsArgs(limit = limit).toPayload())
                .await().data
            @Suppress("UNCHECKED_CAST")
            decodeListRescheduleRequestsResult(raw as? Map<String, Any?>).requests
        }.onFailure { AuntieLog.e("VisitRequestRepository.listRescheduleRequests failed", it) }

    /** Every visit with a cancellation ask still waiting on a decision, oldest first. */
    suspend fun listCancelRequests(limit: Long? = null): Result<List<CancelRequestDto>> =
        runCatching {
            val raw = functions.getHttpsCallable("listCancelRequests")
                .call(ListCancelRequestsArgs(limit = limit).toPayload())
                .await().data
            @Suppress("UNCHECKED_CAST")
            decodeListCancelRequestsResult(raw as? Map<String, Any?>).requests
        }.onFailure { AuntieLog.e("VisitRequestRepository.listCancelRequests failed", it) }

    /**
     * Accepts or declines a reschedule ask. ACCEPTING MOVES THE VISIT, and the
     * server moves both the household's kinCares doc and the flat
     * `kin_care_sessions` row, which is what keeps this app's schedule and the
     * portal from disagreeing about when a visit is.
     */
    suspend fun resolveRescheduleRequest(
        kinfolkId: String,
        batchId: String,
        visitId: String,
        decision: String,
        note: String? = null,
    ): Result<ResolveBookingRescheduleRequestResult> = runCatching {
        val raw = functions.getHttpsCallable("resolveBookingRescheduleRequest")
            .call(
                ResolveBookingRescheduleRequestArgs(
                    kinfolkId = kinfolkId,
                    batchId = batchId,
                    visitId = visitId,
                    decision = decision,
                    note = note?.takeIf { it.isNotBlank() },
                ).toPayload(),
            )
            .await().data
        @Suppress("UNCHECKED_CAST")
        decodeResolveBookingRescheduleRequestResult(raw as? Map<String, Any?>)
    }.onFailure { AuntieLog.e("VisitRequestRepository.resolveRescheduleRequest failed", it) }

    /**
     * Accepts or declines a cancellation ask. ACCEPTING CANCELS THE VISIT on
     * both records, the same pair, for the same reason.
     */
    suspend fun resolveCancellationRequest(
        kinfolkId: String,
        batchId: String,
        visitId: String,
        decision: String,
        note: String? = null,
    ): Result<ResolveBookingCancellationRequestResult> = runCatching {
        val raw = functions.getHttpsCallable("resolveBookingCancellationRequest")
            .call(
                ResolveBookingCancellationRequestArgs(
                    kinfolkId = kinfolkId,
                    batchId = batchId,
                    visitId = visitId,
                    decision = decision,
                    note = note?.takeIf { it.isNotBlank() },
                ).toPayload(),
            )
            .await().data
        @Suppress("UNCHECKED_CAST")
        decodeResolveBookingCancellationRequestResult(raw as? Map<String, Any?>)
    }.onFailure { AuntieLog.e("VisitRequestRepository.resolveCancellationRequest failed", it) }
}
