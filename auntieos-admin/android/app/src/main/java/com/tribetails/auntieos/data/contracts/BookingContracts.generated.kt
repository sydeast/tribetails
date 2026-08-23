// GENERATED FILE. DO NOT EDIT.
//
// The Contracts module (CONTEXT.md), generated from the server zod schemas
// under ADR-0001 decision 2. The schema is the authority for both directions;
// this file is a projection of it and any hand edit is lost on the next run.
//
// Source:      mytribe/functions/src/{admin,portal}/*.ts (zod Args + Result)
// Regenerate:  npm --prefix mytribe/functions run contracts:generate
// Verify:      npm --prefix mytribe/functions run contracts:check
//
// CI runs the verify command and fails on any difference, so a schema change
// and its generated fallout land in one reviewable commit.

@file:Suppress("UNCHECKED_CAST")

package com.tribetails.auntieos.data.contracts

/**
 * A nested payload object, or null when the wire value is not a map.
 *
 * The cast is unchecked because a JSON map arrives as `Map<*, *>` with no element
 * types; every value read out of it is re-checked one field at a time below.
 */
private fun contractRawMap(value: Any?): Map<String, Any?>? = value as? Map<String, Any?>

// ---------- Types shared by more than one callable ----------

/** `RescheduleRequestDto`, shared across callables. */
data class RescheduleRequestDto(
    val kinfolkId: String,
    val batchId: String,
    val visitId: String,
    val title: String?,
    val serviceType: String?,
    val kinNames: List<String>,
    val status: String?,
    val currentStartTimeMs: Long?,
    val currentEndTimeMs: Long?,
    val proposedStartTimeMs: Long?,
    val proposedEndTimeMs: Long?,
    val reason: String?,
    val requestedAtMs: Long?,
)

/**
 * Fail-soft decode of `RescheduleRequestDto` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeRescheduleRequestDto(raw: Map<String, Any?>?): RescheduleRequestDto =
    RescheduleRequestDto(
        kinfolkId = (raw?.get("kinfolkId") as? String).orEmpty(),
        batchId = (raw?.get("batchId") as? String).orEmpty(),
        visitId = (raw?.get("visitId") as? String).orEmpty(),
        title = raw?.get("title") as? String,
        serviceType = raw?.get("serviceType") as? String,
        kinNames = (raw?.get("kinNames") as? List<*>).orEmpty().mapNotNull { it as? String },
        status = raw?.get("status") as? String,
        currentStartTimeMs = (raw?.get("currentStartTimeMs") as? Number)?.toLong(),
        currentEndTimeMs = (raw?.get("currentEndTimeMs") as? Number)?.toLong(),
        proposedStartTimeMs = (raw?.get("proposedStartTimeMs") as? Number)?.toLong(),
        proposedEndTimeMs = (raw?.get("proposedEndTimeMs") as? Number)?.toLong(),
        reason = raw?.get("reason") as? String,
        requestedAtMs = (raw?.get("requestedAtMs") as? Number)?.toLong(),
    )

/** `CancelRequestDto`, shared across callables. */
data class CancelRequestDto(
    val kinfolkId: String,
    val batchId: String,
    val visitId: String,
    val title: String?,
    val serviceType: String?,
    val kinNames: List<String>,
    val status: String?,
    val startTimeMs: Long?,
    val endTimeMs: Long?,
    val reason: String?,
    val requestedAtMs: Long?,
)

/**
 * Fail-soft decode of `CancelRequestDto` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeCancelRequestDto(raw: Map<String, Any?>?): CancelRequestDto =
    CancelRequestDto(
        kinfolkId = (raw?.get("kinfolkId") as? String).orEmpty(),
        batchId = (raw?.get("batchId") as? String).orEmpty(),
        visitId = (raw?.get("visitId") as? String).orEmpty(),
        title = raw?.get("title") as? String,
        serviceType = raw?.get("serviceType") as? String,
        kinNames = (raw?.get("kinNames") as? List<*>).orEmpty().mapNotNull { it as? String },
        status = raw?.get("status") as? String,
        startTimeMs = (raw?.get("startTimeMs") as? Number)?.toLong(),
        endTimeMs = (raw?.get("endTimeMs") as? Number)?.toLong(),
        reason = raw?.get("reason") as? String,
        requestedAtMs = (raw?.get("requestedAtMs") as? Number)?.toLong(),
    )

// ---------- addBookingNote ----------

/**
 * Request payload for the `addBookingNote` callable.
 * The server also enforces a cross-field rule this class cannot express (zod .refine);
 * a payload that satisfies these types can still be refused.
 */
data class AddBookingNoteArgs(
    /** Optional: omitted from the payload when null. */
    val kinfolkId: String? = null,
    /** Optional: omitted from the payload when null. */
    val batchId: String? = null,
    /** Optional: omitted from the payload when null. */
    val visitId: String? = null,
    /** Optional: omitted from the payload when null. */
    val bookingId: String? = null,
    val body: String,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        if (kinfolkId != null) put("kinfolkId", kinfolkId)
        if (batchId != null) put("batchId", batchId)
        if (visitId != null) put("visitId", visitId)
        if (bookingId != null) put("bookingId", bookingId)
        put("body", body)
    }
}

/** Response from the `addBookingNote` callable. */
data class AddBookingNoteResult(
    val noteId: String,
)

/**
 * Fail-soft decode of `AddBookingNoteResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeAddBookingNoteResult(raw: Map<String, Any?>?): AddBookingNoteResult =
    AddBookingNoteResult(
        noteId = (raw?.get("noteId") as? String).orEmpty(),
    )

// ---------- addInternalBookingNote ----------

/**
 * Request payload for the `addInternalBookingNote` callable.
 * The server also enforces a cross-field rule this class cannot express (zod .refine);
 * a payload that satisfies these types can still be refused.
 */
data class AddInternalBookingNoteArgs(
    val kinfolkId: String,
    /** Optional: omitted from the payload when null. */
    val batchId: String? = null,
    /** Optional: omitted from the payload when null. */
    val visitId: String? = null,
    /** Optional: omitted from the payload when null. */
    val bookingId: String? = null,
    val body: String,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("kinfolkId", kinfolkId)
        if (batchId != null) put("batchId", batchId)
        if (visitId != null) put("visitId", visitId)
        if (bookingId != null) put("bookingId", bookingId)
        put("body", body)
    }
}

/** Response from the `addInternalBookingNote` callable. */
data class AddInternalBookingNoteResult(
    val noteId: String,
)

/**
 * Fail-soft decode of `AddInternalBookingNoteResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeAddInternalBookingNoteResult(raw: Map<String, Any?>?): AddInternalBookingNoteResult =
    AddInternalBookingNoteResult(
        noteId = (raw?.get("noteId") as? String).orEmpty(),
    )

// ---------- batchUpdateBookings ----------

/** Request payload for the `batchUpdateBookings` callable. */
data class BatchUpdateBookingsArgs(
    val ids: List<String>,
    /** One of `APPROVE`, `REJECT`, `CANCEL`. */
    val action: String,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("ids", ids)
        put("action", action)
    }
}

/** Nested in the `batchUpdateBookings` contract. */
data class BatchUpdateBookingsResultFailed(
    val id: String,
    val error: String,
)

/**
 * Fail-soft decode of `BatchUpdateBookingsResultFailed` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeBatchUpdateBookingsResultFailed(raw: Map<String, Any?>?): BatchUpdateBookingsResultFailed =
    BatchUpdateBookingsResultFailed(
        id = (raw?.get("id") as? String).orEmpty(),
        error = (raw?.get("error") as? String).orEmpty(),
    )

/** Response from the `batchUpdateBookings` callable. */
data class BatchUpdateBookingsResult(
    val ok: Boolean,
    /** One of `APPROVE`, `REJECT`, `CANCEL`. `""` when the payload omits it. */
    val action: String,
    val updated: Long,
    val failed: List<BatchUpdateBookingsResultFailed>,
)

/**
 * Fail-soft decode of `BatchUpdateBookingsResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeBatchUpdateBookingsResult(raw: Map<String, Any?>?): BatchUpdateBookingsResult =
    BatchUpdateBookingsResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        action = (raw?.get("action") as? String).orEmpty(),
        updated = (raw?.get("updated") as? Number)?.toLong() ?: 0L,
        failed = (raw?.get("failed") as? List<*>).orEmpty().mapNotNull { contractRawMap(it)?.let { nested -> decodeBatchUpdateBookingsResultFailed(nested) } },
    )

// ---------- createMultiDateBookingRequest ----------

/** Nested in the `createMultiDateBookingRequest` contract. */
data class CreateMultiDateBookingRequestArgsVisit(
    val startTimeMs: Long,
    val endTimeMs: Long?,
    val serviceId: String?,
    val serviceName: String,
    val priceCents: Long?,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("startTimeMs", startTimeMs)
        put("endTimeMs", endTimeMs)
        put("serviceId", serviceId)
        put("serviceName", serviceName)
        put("priceCents", priceCents)
    }
}

/** Nested in the `createMultiDateBookingRequest` contract. */
data class CreateMultiDateBookingRequestArgsBilling(
    /** One of `new-invoice`. */
    val mode: String,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("mode", mode)
    }
}

/** Nested in the `createMultiDateBookingRequest` contract. */
data class CreateMultiDateBookingRequestArgsCommunication(
    val emailConfirmation: Boolean,
    val timeVisibility: Boolean,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("emailConfirmation", emailConfirmation)
        put("timeVisibility", timeVisibility)
    }
}

/** Request payload for the `createMultiDateBookingRequest` callable. */
data class CreateMultiDateBookingRequestArgs(
    val kinfolkId: String,
    /** Optional: omitted from the payload when null. */
    val kinIds: List<String>? = null,
    /** Optional: omitted from the payload when null. */
    val notes: String? = null,
    /**
     * One of `individual`, `weekly`.
     * Optional: omitted from the payload when null.
     */
    val pattern: String? = null,
    /** Optional: omitted from the payload when null. */
    val weeklyDays: List<Long>? = null,
    val visits: List<CreateMultiDateBookingRequestArgsVisit>,
    /** Optional: omitted from the payload when null. */
    val billing: CreateMultiDateBookingRequestArgsBilling? = null,
    /** Optional: omitted from the payload when null. */
    val communication: CreateMultiDateBookingRequestArgsCommunication? = null,
    /** Optional: omitted from the payload when null. */
    val overrideBusyConflict: Boolean? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("kinfolkId", kinfolkId)
        if (kinIds != null) put("kinIds", kinIds)
        if (notes != null) put("notes", notes)
        if (pattern != null) put("pattern", pattern)
        if (weeklyDays != null) put("weeklyDays", weeklyDays)
        put("visits", visits.map { it.toPayload() })
        if (billing != null) put("billing", billing.toPayload())
        if (communication != null) put("communication", communication.toPayload())
        if (overrideBusyConflict != null) put("overrideBusyConflict", overrideBusyConflict)
    }
}

/** Response from the `createMultiDateBookingRequest` callable. */
data class CreateMultiDateBookingRequestResult(
    val batchId: String,
    val visitIds: List<String>,
    val visitCount: Long,
)

/**
 * Fail-soft decode of `CreateMultiDateBookingRequestResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeCreateMultiDateBookingRequestResult(raw: Map<String, Any?>?): CreateMultiDateBookingRequestResult =
    CreateMultiDateBookingRequestResult(
        batchId = (raw?.get("batchId") as? String).orEmpty(),
        visitIds = (raw?.get("visitIds") as? List<*>).orEmpty().mapNotNull { it as? String },
        visitCount = (raw?.get("visitCount") as? Number)?.toLong() ?: 0L,
    )

// ---------- getMyBookings ----------

// No request class: `getMyBookings` has no zod request schema on the server,
// so there is no authority to generate one from.

/** Nested in the `getMyBookings` contract. */
data class GetMyBookingsResultLiveVisit(
    val id: String,
    val batchId: String?,
    val kinfolkId: String,
    /** One of `requested`, `confirmed`, `enRoute`, `active`, `completed`, `cancelled`. `""` when the payload omits it. */
    val status: String,
    val serviceType: String?,
    val title: String?,
    val startTimeMs: Long?,
    val endTimeMs: Long?,
    val kinIds: List<String>,
    val kinNames: List<String>,
    val auntieDisplayName: String?,
    val auntieAvatarUrl: String?,
    val notes: String?,
    val requestedByUid: String?,
    val createdAtMs: Long?,
    val updatedAtMs: Long?,
    /** One of `confirmed`, `enRoute`, `active`, `ended`, or null when the payload omits it. */
    val visitProgress: String?,
    val sourceBookingId: String?,
    val sessionId: String?,
    val cancelRequested: Boolean,
    /** One of `pending`, `accepted`, `declined`, or null when the payload omits it. */
    val cancelRequestStatus: String?,
    val cancelRequestReason: String?,
    val cancelResponseNote: String?,
    /** One of `pending`, `accepted`, `declined`, or null when the payload omits it. */
    val rescheduleRequestStatus: String?,
    val rescheduleRequestedStartTimeMs: Long?,
    val rescheduleRequestedEndTimeMs: Long?,
    val rescheduleRequestReason: String?,
    val rescheduleResponseNote: String?,
)

/**
 * Fail-soft decode of `GetMyBookingsResultLiveVisit` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeGetMyBookingsResultLiveVisit(raw: Map<String, Any?>?): GetMyBookingsResultLiveVisit =
    GetMyBookingsResultLiveVisit(
        id = (raw?.get("id") as? String).orEmpty(),
        batchId = raw?.get("batchId") as? String,
        kinfolkId = (raw?.get("kinfolkId") as? String).orEmpty(),
        status = (raw?.get("status") as? String).orEmpty(),
        serviceType = raw?.get("serviceType") as? String,
        title = raw?.get("title") as? String,
        startTimeMs = (raw?.get("startTimeMs") as? Number)?.toLong(),
        endTimeMs = (raw?.get("endTimeMs") as? Number)?.toLong(),
        kinIds = (raw?.get("kinIds") as? List<*>).orEmpty().mapNotNull { it as? String },
        kinNames = (raw?.get("kinNames") as? List<*>).orEmpty().mapNotNull { it as? String },
        auntieDisplayName = raw?.get("auntieDisplayName") as? String,
        auntieAvatarUrl = raw?.get("auntieAvatarUrl") as? String,
        notes = raw?.get("notes") as? String,
        requestedByUid = raw?.get("requestedByUid") as? String,
        createdAtMs = (raw?.get("createdAtMs") as? Number)?.toLong(),
        updatedAtMs = (raw?.get("updatedAtMs") as? Number)?.toLong(),
        visitProgress = raw?.get("visitProgress") as? String,
        sourceBookingId = raw?.get("sourceBookingId") as? String,
        sessionId = raw?.get("sessionId") as? String,
        cancelRequested = raw?.get("cancelRequested") as? Boolean ?: false,
        cancelRequestStatus = raw?.get("cancelRequestStatus") as? String,
        cancelRequestReason = raw?.get("cancelRequestReason") as? String,
        cancelResponseNote = raw?.get("cancelResponseNote") as? String,
        rescheduleRequestStatus = raw?.get("rescheduleRequestStatus") as? String,
        rescheduleRequestedStartTimeMs = (raw?.get("rescheduleRequestedStartTimeMs") as? Number)?.toLong(),
        rescheduleRequestedEndTimeMs = (raw?.get("rescheduleRequestedEndTimeMs") as? Number)?.toLong(),
        rescheduleRequestReason = raw?.get("rescheduleRequestReason") as? String,
        rescheduleResponseNote = raw?.get("rescheduleResponseNote") as? String,
    )

/** Nested in the `getMyBookings` contract. */
data class GetMyBookingsResultEnvelope(
    val batchId: String,
    /** One of `requested`, `partiallyConfirmed`, `confirmed`, `inProgress`, `completed`, `cancelled`. `""` when the payload omits it. */
    val envelopeStatus: String,
    /** One of `individual`, `weekly`. `""` when the payload omits it. */
    val pattern: String,
    val serviceName: String?,
    val kinIds: List<String>,
    val kinNames: List<String>,
    val notes: String?,
    val visitCount: Long,
    val confirmedCount: Long,
    val completedCount: Long,
    val firstStartTimeMs: Long?,
    val lastStartTimeMs: Long?,
    val kinCares: List<GetMyBookingsResultLiveVisit>,
)

/**
 * Fail-soft decode of `GetMyBookingsResultEnvelope` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeGetMyBookingsResultEnvelope(raw: Map<String, Any?>?): GetMyBookingsResultEnvelope =
    GetMyBookingsResultEnvelope(
        batchId = (raw?.get("batchId") as? String).orEmpty(),
        envelopeStatus = (raw?.get("envelopeStatus") as? String).orEmpty(),
        pattern = (raw?.get("pattern") as? String).orEmpty(),
        serviceName = raw?.get("serviceName") as? String,
        kinIds = (raw?.get("kinIds") as? List<*>).orEmpty().mapNotNull { it as? String },
        kinNames = (raw?.get("kinNames") as? List<*>).orEmpty().mapNotNull { it as? String },
        notes = raw?.get("notes") as? String,
        visitCount = (raw?.get("visitCount") as? Number)?.toLong() ?: 0L,
        confirmedCount = (raw?.get("confirmedCount") as? Number)?.toLong() ?: 0L,
        completedCount = (raw?.get("completedCount") as? Number)?.toLong() ?: 0L,
        firstStartTimeMs = (raw?.get("firstStartTimeMs") as? Number)?.toLong(),
        lastStartTimeMs = (raw?.get("lastStartTimeMs") as? Number)?.toLong(),
        kinCares = (raw?.get("kinCares") as? List<*>).orEmpty().mapNotNull { contractRawMap(it)?.let { nested -> decodeGetMyBookingsResultLiveVisit(nested) } },
    )

/** Response from the `getMyBookings` callable. */
data class GetMyBookingsResult(
    val liveVisit: GetMyBookingsResultLiveVisit?,
    val upcoming: List<GetMyBookingsResultLiveVisit>,
    val recent: List<GetMyBookingsResultLiveVisit>,
    val envelopes: List<GetMyBookingsResultEnvelope>,
)

/**
 * Fail-soft decode of `GetMyBookingsResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeGetMyBookingsResult(raw: Map<String, Any?>?): GetMyBookingsResult =
    GetMyBookingsResult(
        liveVisit = contractRawMap(raw?.get("liveVisit"))?.let { nested -> decodeGetMyBookingsResultLiveVisit(nested) },
        upcoming = (raw?.get("upcoming") as? List<*>).orEmpty().mapNotNull { contractRawMap(it)?.let { nested -> decodeGetMyBookingsResultLiveVisit(nested) } },
        recent = (raw?.get("recent") as? List<*>).orEmpty().mapNotNull { contractRawMap(it)?.let { nested -> decodeGetMyBookingsResultLiveVisit(nested) } },
        envelopes = (raw?.get("envelopes") as? List<*>).orEmpty().mapNotNull { contractRawMap(it)?.let { nested -> decodeGetMyBookingsResultEnvelope(nested) } },
    )

// ---------- manageBookingSeries ----------

/** Request payload for the `manageBookingSeries` callable. */
data class ManageBookingSeriesArgs(
    /** One of `APPROVE`, `CANCEL`. */
    val action: String,
    val kinfolkId: String,
    val batchId: String,
    /** Optional: omitted from the payload when null. */
    val note: String? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("action", action)
        put("kinfolkId", kinfolkId)
        put("batchId", batchId)
        if (note != null) put("note", note)
    }
}

/** Response from the `manageBookingSeries` callable. */
data class ManageBookingSeriesResult(
    val ok: Boolean,
    /** One of `APPROVE`, `CANCEL`. `""` when the payload omits it. */
    val action: String,
    val batchId: String,
    val affectedVisits: Long,
    val sessionsCreated: Long,
    val failedVisits: Long,
)

/**
 * Fail-soft decode of `ManageBookingSeriesResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeManageBookingSeriesResult(raw: Map<String, Any?>?): ManageBookingSeriesResult =
    ManageBookingSeriesResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        action = (raw?.get("action") as? String).orEmpty(),
        batchId = (raw?.get("batchId") as? String).orEmpty(),
        affectedVisits = (raw?.get("affectedVisits") as? Number)?.toLong() ?: 0L,
        sessionsCreated = (raw?.get("sessionsCreated") as? Number)?.toLong() ?: 0L,
        failedVisits = (raw?.get("failedVisits") as? Number)?.toLong() ?: 0L,
    )

// ---------- requestBooking ----------

/** Nested in the `requestBooking` contract. */
data class RequestBookingArgsVisit(
    val startTimeMs: Long,
    val endTimeMs: Long?,
    val serviceId: String,
    val serviceName: String,
    val priceCents: Long?,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("startTimeMs", startTimeMs)
        put("endTimeMs", endTimeMs)
        put("serviceId", serviceId)
        put("serviceName", serviceName)
        put("priceCents", priceCents)
    }
}

/** Nested in the `requestBooking` contract. */
data class RequestBookingArgsBilling(
    /** One of `new-invoice`. */
    val mode: String,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("mode", mode)
    }
}

/** Nested in the `requestBooking` contract. */
data class RequestBookingArgsCommunication(
    val emailConfirmation: Boolean,
    val timeVisibility: Boolean,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("emailConfirmation", emailConfirmation)
        put("timeVisibility", timeVisibility)
    }
}

/** Request payload for the `requestBooking` callable. */
data class RequestBookingArgs(
    /** Optional: omitted from the payload when null. */
    val kinfolkId: String? = null,
    /** Optional: omitted from the payload when null. */
    val kinIds: List<String>? = null,
    /** Optional: omitted from the payload when null. */
    val notes: String? = null,
    /**
     * One of `individual`, `weekly`.
     * Optional: omitted from the payload when null.
     */
    val pattern: String? = null,
    /** Optional: omitted from the payload when null. */
    val weeklyDays: List<Long>? = null,
    /** Optional: omitted from the payload when null. */
    val visits: List<RequestBookingArgsVisit>? = null,
    /** Optional: omitted from the payload when null. */
    val billing: RequestBookingArgsBilling? = null,
    /** Optional: omitted from the payload when null. */
    val communication: RequestBookingArgsCommunication? = null,
    /** Optional: omitted from the payload when null. */
    val serviceType: String? = null,
    /** Optional: omitted from the payload when null. */
    val title: String? = null,
    /** Optional: omitted from the payload when null. */
    val startTimeMs: Long? = null,
    /** Optional: omitted from the payload when null. */
    val endTimeMs: Long? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        if (kinfolkId != null) put("kinfolkId", kinfolkId)
        if (kinIds != null) put("kinIds", kinIds)
        if (notes != null) put("notes", notes)
        if (pattern != null) put("pattern", pattern)
        if (weeklyDays != null) put("weeklyDays", weeklyDays)
        if (visits != null) put("visits", visits.map { it.toPayload() })
        if (billing != null) put("billing", billing.toPayload())
        if (communication != null) put("communication", communication.toPayload())
        if (serviceType != null) put("serviceType", serviceType)
        if (title != null) put("title", title)
        if (startTimeMs != null) put("startTimeMs", startTimeMs)
        if (endTimeMs != null) put("endTimeMs", endTimeMs)
    }
}

/** Response from the `requestBooking` callable. */
data class RequestBookingResult(
    val batchId: String,
    val bookingIds: List<String>,
    val bookingId: String,
)

/**
 * Fail-soft decode of `RequestBookingResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeRequestBookingResult(raw: Map<String, Any?>?): RequestBookingResult =
    RequestBookingResult(
        batchId = (raw?.get("batchId") as? String).orEmpty(),
        bookingIds = (raw?.get("bookingIds") as? List<*>).orEmpty().mapNotNull { it as? String },
        bookingId = (raw?.get("bookingId") as? String).orEmpty(),
    )

// ---------- requestBookingCancellation ----------

/** Request payload for the `requestBookingCancellation` callable. */
data class RequestBookingCancellationArgs(
    /** Optional: omitted from the payload when null. */
    val kinfolkId: String? = null,
    val batchId: String,
    val visitId: String,
    /** Optional: omitted from the payload when null. */
    val reason: String? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        if (kinfolkId != null) put("kinfolkId", kinfolkId)
        put("batchId", batchId)
        put("visitId", visitId)
        if (reason != null) put("reason", reason)
    }
}

/** Response from the `requestBookingCancellation` callable. */
data class RequestBookingCancellationResult(
    val ok: Boolean,
    val visitId: String,
    val alreadyPending: Boolean,
)

/**
 * Fail-soft decode of `RequestBookingCancellationResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeRequestBookingCancellationResult(raw: Map<String, Any?>?): RequestBookingCancellationResult =
    RequestBookingCancellationResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        visitId = (raw?.get("visitId") as? String).orEmpty(),
        alreadyPending = raw?.get("alreadyPending") as? Boolean ?: false,
    )

// ---------- requestBookingReschedule ----------

/** Request payload for the `requestBookingReschedule` callable. */
data class RequestBookingRescheduleArgs(
    /** Optional: omitted from the payload when null. */
    val kinfolkId: String? = null,
    val batchId: String,
    val visitId: String,
    val proposedStartTimeMs: Long,
    /** Optional: omitted from the payload when null. */
    val proposedEndTimeMs: Long? = null,
    /** Optional: omitted from the payload when null. */
    val reason: String? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        if (kinfolkId != null) put("kinfolkId", kinfolkId)
        put("batchId", batchId)
        put("visitId", visitId)
        put("proposedStartTimeMs", proposedStartTimeMs)
        if (proposedEndTimeMs != null) put("proposedEndTimeMs", proposedEndTimeMs)
        if (reason != null) put("reason", reason)
    }
}

/** Response from the `requestBookingReschedule` callable. */
data class RequestBookingRescheduleResult(
    val ok: Boolean,
    val visitId: String,
    val proposedStartTimeMs: Long,
    val proposedEndTimeMs: Long?,
)

/**
 * Fail-soft decode of `RequestBookingRescheduleResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeRequestBookingRescheduleResult(raw: Map<String, Any?>?): RequestBookingRescheduleResult =
    RequestBookingRescheduleResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        visitId = (raw?.get("visitId") as? String).orEmpty(),
        proposedStartTimeMs = (raw?.get("proposedStartTimeMs") as? Number)?.toLong() ?: 0L,
        proposedEndTimeMs = (raw?.get("proposedEndTimeMs") as? Number)?.toLong(),
    )

// ---------- rescheduleBooking ----------

/** Request payload for the `rescheduleBooking` callable. */
data class RescheduleBookingArgs(
    val sessionId: String,
    val startTime: String,
    val endTime: String,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("sessionId", sessionId)
        put("startTime", startTime)
        put("endTime", endTime)
    }
}

/** Response from the `rescheduleBooking` callable. */
data class RescheduleBookingResult(
    val ok: Boolean,
    val sessionId: String,
)

/**
 * Fail-soft decode of `RescheduleBookingResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeRescheduleBookingResult(raw: Map<String, Any?>?): RescheduleBookingResult =
    RescheduleBookingResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        sessionId = (raw?.get("sessionId") as? String).orEmpty(),
    )

// ---------- resolveBookingRescheduleRequest ----------

/** Request payload for the `resolveBookingRescheduleRequest` callable. */
data class ResolveBookingRescheduleRequestArgs(
    val kinfolkId: String,
    val batchId: String,
    val visitId: String,
    /** One of `accept`, `decline`. */
    val decision: String,
    /** Optional: omitted from the payload when null. */
    val note: String? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("kinfolkId", kinfolkId)
        put("batchId", batchId)
        put("visitId", visitId)
        put("decision", decision)
        if (note != null) put("note", note)
    }
}

/** Response from the `resolveBookingRescheduleRequest` callable. */
data class ResolveBookingRescheduleRequestResult(
    val ok: Boolean,
    val visitId: String,
    /** One of `accept`, `decline`. `""` when the payload omits it. */
    val decision: String,
    val startTimeMs: Long?,
    val sessionUpdated: Boolean,
)

/**
 * Fail-soft decode of `ResolveBookingRescheduleRequestResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeResolveBookingRescheduleRequestResult(raw: Map<String, Any?>?): ResolveBookingRescheduleRequestResult =
    ResolveBookingRescheduleRequestResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        visitId = (raw?.get("visitId") as? String).orEmpty(),
        decision = (raw?.get("decision") as? String).orEmpty(),
        startTimeMs = (raw?.get("startTimeMs") as? Number)?.toLong(),
        sessionUpdated = raw?.get("sessionUpdated") as? Boolean ?: false,
    )

// ---------- listRescheduleRequests ----------

/** Request payload for the `listRescheduleRequests` callable. */
data class ListRescheduleRequestsArgs(
    /** Optional: omitted from the payload when null. */
    val limit: Long? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        if (limit != null) put("limit", limit)
    }
}

/** Response from the `listRescheduleRequests` callable. */
data class ListRescheduleRequestsResult(
    val requests: List<RescheduleRequestDto>,
)

/**
 * Fail-soft decode of `ListRescheduleRequestsResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeListRescheduleRequestsResult(raw: Map<String, Any?>?): ListRescheduleRequestsResult =
    ListRescheduleRequestsResult(
        requests = (raw?.get("requests") as? List<*>).orEmpty().mapNotNull { contractRawMap(it)?.let { nested -> decodeRescheduleRequestDto(nested) } },
    )

// ---------- resolveBookingCancellationRequest ----------

/** Request payload for the `resolveBookingCancellationRequest` callable. */
data class ResolveBookingCancellationRequestArgs(
    val kinfolkId: String,
    val batchId: String,
    val visitId: String,
    /** One of `accept`, `decline`. */
    val decision: String,
    /** Optional: omitted from the payload when null. */
    val note: String? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        put("kinfolkId", kinfolkId)
        put("batchId", batchId)
        put("visitId", visitId)
        put("decision", decision)
        if (note != null) put("note", note)
    }
}

/** Response from the `resolveBookingCancellationRequest` callable. */
data class ResolveBookingCancellationRequestResult(
    val ok: Boolean,
    val visitId: String,
    /** One of `accept`, `decline`. `""` when the payload omits it. */
    val decision: String,
    val status: String?,
    val sessionUpdated: Boolean,
    val rescheduleRequestClosed: Boolean,
)

/**
 * Fail-soft decode of `ResolveBookingCancellationRequestResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeResolveBookingCancellationRequestResult(raw: Map<String, Any?>?): ResolveBookingCancellationRequestResult =
    ResolveBookingCancellationRequestResult(
        ok = raw?.get("ok") as? Boolean ?: false,
        visitId = (raw?.get("visitId") as? String).orEmpty(),
        decision = (raw?.get("decision") as? String).orEmpty(),
        status = raw?.get("status") as? String,
        sessionUpdated = raw?.get("sessionUpdated") as? Boolean ?: false,
        rescheduleRequestClosed = raw?.get("rescheduleRequestClosed") as? Boolean ?: false,
    )

// ---------- listCancelRequests ----------

/** Request payload for the `listCancelRequests` callable. */
data class ListCancelRequestsArgs(
    /** Optional: omitted from the payload when null. */
    val limit: Long? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        if (limit != null) put("limit", limit)
    }
}

/** Response from the `listCancelRequests` callable. */
data class ListCancelRequestsResult(
    val requests: List<CancelRequestDto>,
)

/**
 * Fail-soft decode of `ListCancelRequestsResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeListCancelRequestsResult(raw: Map<String, Any?>?): ListCancelRequestsResult =
    ListCancelRequestsResult(
        requests = (raw?.get("requests") as? List<*>).orEmpty().mapNotNull { contractRawMap(it)?.let { nested -> decodeCancelRequestDto(nested) } },
    )

// ---------- listPendingBookingRequests ----------

/** Request payload for the `listPendingBookingRequests` callable. */
data class ListPendingBookingRequestsArgs(
    /** Optional: omitted from the payload when null. */
    val limit: Long? = null,
) {
    /**
     * The wire payload for this request, in the `recordPaymentPayload` convention:
     * a pure map, no Firebase types, so a test can assert it without static init.
     */
    fun toPayload(): Map<String, Any?> = buildMap<String, Any?> {
        if (limit != null) put("limit", limit)
    }
}

/** Nested in the `listPendingBookingRequests` contract. */
data class ListPendingBookingRequestsResultRequest(
    val kinfolkId: String,
    val batchId: String,
    val kinfolkName: String?,
    val serviceType: String?,
    val kinNames: List<String>,
    val notes: String?,
    val visitCount: Long,
    val firstStartTimeMs: Long?,
    val lastStartTimeMs: Long?,
    val startTimeMsList: List<Long>,
    val requestedAtMs: Long?,
)

/**
 * Fail-soft decode of `ListPendingBookingRequestsResultRequest` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeListPendingBookingRequestsResultRequest(raw: Map<String, Any?>?): ListPendingBookingRequestsResultRequest =
    ListPendingBookingRequestsResultRequest(
        kinfolkId = (raw?.get("kinfolkId") as? String).orEmpty(),
        batchId = (raw?.get("batchId") as? String).orEmpty(),
        kinfolkName = raw?.get("kinfolkName") as? String,
        serviceType = raw?.get("serviceType") as? String,
        kinNames = (raw?.get("kinNames") as? List<*>).orEmpty().mapNotNull { it as? String },
        notes = raw?.get("notes") as? String,
        visitCount = (raw?.get("visitCount") as? Number)?.toLong() ?: 0L,
        firstStartTimeMs = (raw?.get("firstStartTimeMs") as? Number)?.toLong(),
        lastStartTimeMs = (raw?.get("lastStartTimeMs") as? Number)?.toLong(),
        startTimeMsList = (raw?.get("startTimeMsList") as? List<*>).orEmpty().mapNotNull { (it as? Number)?.toLong() },
        requestedAtMs = (raw?.get("requestedAtMs") as? Number)?.toLong(),
    )

/** Response from the `listPendingBookingRequests` callable. */
data class ListPendingBookingRequestsResult(
    val requests: List<ListPendingBookingRequestsResultRequest>,
)

/**
 * Fail-soft decode of `ListPendingBookingRequestsResult` from a callable payload.
 * Pure, and it never throws: a missing or wrong-typed value falls back to the
 * neutral one for its type, and a list entry of the wrong type is dropped.
 */
internal fun decodeListPendingBookingRequestsResult(raw: Map<String, Any?>?): ListPendingBookingRequestsResult =
    ListPendingBookingRequestsResult(
        requests = (raw?.get("requests") as? List<*>).orEmpty().mapNotNull { contractRawMap(it)?.let { nested -> decodeListPendingBookingRequestsResultRequest(nested) } },
    )
