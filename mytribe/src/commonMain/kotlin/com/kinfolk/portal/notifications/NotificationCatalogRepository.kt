package com.kinfolk.portal.notifications

import com.kinfolk.portal.firebase.FunctionsClient
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * Fetches the kinfolk-facing notification catalog from the server callable
 * `getNotificationCatalog`. Replaces the previously hand-maintained mirror
 * in `NotificationCatalog.kt` (closes TODO(E5b)).
 *
 * The repository caches the first successful fetch in-memory for the life of
 * the session. The fallback static `KINFOLK_CATEGORIES` const remains in
 * `NotificationCatalog.kt` only for tests and as compile-time type seed;
 * UI MUST consume [state] and render a fail-loud banner on
 * [CatalogState.Failure] per project policy. Do NOT silently fall back to
 * the static const at the UI layer; that would re-introduce the drift this
 * class was built to eliminate.
 */
class NotificationCatalogRepository(private val fns: FunctionsClient) {
    private val _state = MutableStateFlow<CatalogState>(CatalogState.Loading)
    val state: StateFlow<CatalogState> = _state.asStateFlow()

    /**
     * Fetches the catalog. Safe to call multiple times: subsequent calls
     * re-issue the request only if the prior result was a Failure; on a
     * cached Success the in-memory state is returned without a round trip.
     */
    suspend fun load(): CatalogState {
        val current = _state.value
        if (current is CatalogState.Success) return current
        return try {
            val raw = fns.call("getNotificationCatalog", null)
            val categories = decodeCategories(raw)
            val schemaVersion = raw["schemaVersion"]?.jsonPrimitive?.contentOrNull?.toIntOrNull() ?: 1
            val result = CatalogState.Success(categories = categories, schemaVersion = schemaVersion)
            _state.value = result
            result
        } catch (t: Throwable) {
            val failure = CatalogState.Failure(
                message = t.message ?: "Couldn't load notification preferences. Try again.",
            )
            _state.value = failure
            failure
        }
    }

    private fun decodeCategories(raw: JsonObject): List<CategoryDef> {
        val arr = (raw["categories"] as? JsonArray) ?: return emptyList()
        return arr.mapNotNull { el ->
            val obj = el as? JsonObject ?: return@mapNotNull null
            CategoryDef(
                id = obj["id"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null,
                title = obj["title"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                description = obj["description"]?.jsonPrimitive?.contentOrNull.orEmpty(),
                keys = (obj["keys"] as? JsonArray)?.mapNotNull(::decodeKey).orEmpty(),
            )
        }
    }

    private fun decodeKey(el: kotlinx.serialization.json.JsonElement): NotificationKey? {
        val obj = el as? JsonObject ?: return null
        val key = obj["key"]?.jsonPrimitive?.contentOrNull ?: return null
        val allowed = (obj["allowedChannels"] as? JsonArray)
            ?.mapNotNull { decodeChannel(it.jsonPrimitive.contentOrNull) }
            ?.toSet()
            ?: emptySet()
        val required = (obj["required"] as? JsonArray)
            ?.mapNotNull { decodeChannel(it.jsonPrimitive.contentOrNull) }
            ?.toSet()
            ?: emptySet()
        // Run-4 #13: admin-locked channels (read-only for the kinfolk).
        val locked = (obj["lockedChannels"] as? JsonArray)
            ?.mapNotNull { decodeChannel(it.jsonPrimitive.contentOrNull) }
            ?.toSet()
            ?: emptySet()
        // #491: the value the dispatcher resolves for each locked channel, so
        // this client renders what will happen rather than assuming "locked
        // means on". A server that does not send the map yet leaves it empty,
        // and an empty map reads as on — the pre-#491 behaviour, not a crash.
        val lockedValues = (obj["lockedChannelValues"] as? JsonObject)
            ?.mapNotNull { (raw, v) ->
                val ch = decodeChannel(raw) ?: return@mapNotNull null
                val on = (v as? JsonPrimitive)?.booleanOrNull ?: return@mapNotNull null
                ch to on
            }
            ?.toMap()
            ?: emptyMap()
        val marketing = obj["marketingCategory"]?.jsonPrimitive?.contentOrNull?.let(::decodeMarketing)
        return NotificationKey(
            key = key,
            title = obj["title"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            description = obj["description"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            allowedChannels = allowed,
            required = required,
            lockedChannels = locked,
            lockedChannelValues = lockedValues,
            // Notification revamp: operator-authored reason for a locked/required
            // key. Null-safe: absent field and JSON null both decode to null.
            lockReason = obj["lockReason"]?.jsonPrimitive?.contentOrNull,
            marketingCategory = marketing,
        )
    }

    private fun decodeChannel(raw: String?): NotificationChannel? = when (raw) {
        "email" -> NotificationChannel.EMAIL
        "sms" -> NotificationChannel.SMS
        "push" -> NotificationChannel.PUSH
        else -> null
    }

    private fun decodeMarketing(raw: String?): MarketingCategory? = when (raw) {
        "newsletter" -> MarketingCategory.NEWSLETTER
        "survey" -> MarketingCategory.SURVEY
        "marketing" -> MarketingCategory.MARKETING
        else -> null
    }
}

sealed class CatalogState {
    object Loading : CatalogState()
    data class Success(
        val categories: List<CategoryDef>,
        val schemaVersion: Int,
    ) : CatalogState()
    data class Failure(val message: String) : CatalogState()
}
