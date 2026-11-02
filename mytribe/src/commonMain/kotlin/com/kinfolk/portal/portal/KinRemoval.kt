package com.kinfolk.portal.portal

import kotlin.time.Instant
import kotlinx.datetime.TimeZone
import kotlinx.datetime.toLocalDateTime
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.JsonNull

/**
 * #1408. A household's request to remove a Kin that has history, as the
 * `requestKinRemoval` callable and the `deleteKin` read return it
 * (`mytribe/functions/src/lib/kinRemovalRequest.ts`). The web twin is
 * `KinRemovalRequestDto` in `mytribe/web/src/api/types.ts`.
 */
data class KinRemovalRequest(
    val id: String,
    /** `pending`, `archived` or `declined`. */
    val status: String,
    val reason: String?,
    val requestedAtMs: Long?,
    val resolvedAtMs: Long?,
    /** The office's optional note on its answer. */
    val resolutionNote: String?,
)

/** The `deleteKin` read (#1314) with the request (#1408) beside it. */
data class KinRemovalOptions(
    val canDelete: Boolean,
    val request: KinRemovalRequest? = null,
)

/**
 * What the foot of the edit dialog offers, the same three cases as
 * `kinRemovalOption` in `mytribe/web/src/lib/kinRemoval.ts`:
 * delete (nothing on file), request (history, no open request; a declined one
 * comes back here with its note), or pending (nothing to tap).
 */
sealed interface KinRemovalOption {
    data object Delete : KinRemovalOption
    data class Request(val declined: KinRemovalRequest?) : KinRemovalOption
    data class Pending(val request: KinRemovalRequest) : KinRemovalOption
}

fun kinRemovalOption(options: KinRemovalOptions): KinRemovalOption {
    if (options.canDelete) return KinRemovalOption.Delete
    val request = options.request
    if (request?.status == "pending") return KinRemovalOption.Pending(request)
    return KinRemovalOption.Request(declined = request?.takeIf { it.status == "declined" })
}

private val MONTH_ABBR = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/** "Nov 2, 2026", in the reader's time zone, like the web's `formatRemovalDate`. */
fun removalDateLabel(epochMillis: Long?, timeZone: TimeZone = TimeZone.currentSystemDefault()): String? {
    if (epochMillis == null) return null
    val date = Instant.fromEpochMilliseconds(epochMillis).toLocalDateTime(timeZone).date
    return "${MONTH_ABBR[date.month.ordinal]} ${date.day}, ${date.year}"
}

private fun JsonObject.text(key: String): String? =
    this[key]?.takeIf { it !is JsonNull }?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotEmpty() }

private fun JsonObject.millis(key: String): Long? =
    this[key]?.takeIf { it !is JsonNull }?.jsonPrimitive?.longOrNull

internal fun decodeKinRemovalRequest(raw: JsonObject?): KinRemovalRequest? {
    if (raw == null) return null
    val id = raw.text("id") ?: return null
    return KinRemovalRequest(
        id = id,
        status = raw.text("status") ?: "pending",
        reason = raw.text("reason"),
        requestedAtMs = raw.millis("requestedAtMs"),
        resolvedAtMs = raw.millis("resolvedAtMs"),
        resolutionNote = raw.text("resolutionNote"),
    )
}

internal fun decodeKinRemovalOptions(raw: JsonObject): KinRemovalOptions = KinRemovalOptions(
    canDelete = raw["canDelete"]?.jsonPrimitive?.booleanOrNull == true,
    request = (raw["removalRequest"] as? JsonObject)?.let { decodeKinRemovalRequest(it) },
)
