package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * The ADMIN's OWN notification receive-preferences (the operator's "what reaches me").
 *
 * Separate from the business gate matrix ([CloudNotificationOverridesRepository]): the
 * gate decides which channels are even OFFERED per notification; these prefs are the
 * operator's choice, within those offered channels, of what they actually receive.
 *
 * Wraps the deployed admin callables (do not change the backend):
 *   - getMyAdminNotificationPrefs  -> { prefs, updatedAtMs } (staff/{uid}.notificationPrefs)
 *   - saveMyAdminNotificationPrefs -> persists { prefs }
 *
 * The prefs shape is the hybrid byKey / byCategory / marketingOptIn used by the
 * dispatcher's resolveChannels (functions/src/notifications/prefs.ts). A missing
 * channel inherits the default (email on, sms/push off), so we only store deviations.
 */

/** The fixed channel order shared by the gate matrix and these prefs. */
val NOTIFICATION_CHANNELS: List<String> = listOf("email", "sms", "push")

/** Partial per-channel choice: null = unset (inherit the default). */
data class ChannelPrefs(
    val email: Boolean? = null,
    val sms: Boolean? = null,
    val push: Boolean? = null,
) {
    fun get(channel: String): Boolean? = when (channel) {
        "email" -> email
        "sms" -> sms
        "push" -> push
        else -> null
    }

    fun with(channel: String, value: Boolean): ChannelPrefs = when (channel) {
        "email" -> copy(email = value)
        "sms" -> copy(sms = value)
        "push" -> copy(push = value)
        else -> this
    }
}

/** A user's notification prefs document (clients/{uid} or staff/{uid}.notificationPrefs). */
data class AdminNotificationPrefs(
    val byKey: Map<String, ChannelPrefs> = emptyMap(),
    val byCategory: Map<String, ChannelPrefs> = emptyMap(),
    val marketingOptIn: Map<String, Boolean> = emptyMap(),
) {
    /**
     * The admin's editable receive choice for one (non-forced) channel of a notification:
     * byKey wins, then byCategory, then the catalog default (email on; sms/push off).
     * Mirrors the dispatcher's resolveChannels precedence for non-locked channels.
     */
    fun userChannelChoice(key: String, category: String, channel: String): Boolean =
        byKey[key]?.get(channel)
            ?: byCategory[category]?.get(channel)
            ?: (channel == "email")

    /** A copy with byKey[key][channel] set, preserving every other pref (no clobber). */
    fun withByKeyChannel(key: String, channel: String, value: Boolean): AdminNotificationPrefs {
        val current = byKey[key] ?: ChannelPrefs()
        return copy(byKey = byKey + (key to current.with(channel, value)))
    }
}

/** Channels the business gate currently OFFERS [entry] on [stream] (allowed AND stream-enabled). */
fun adminGateEnabledChannels(matrix: NotificationMatrix, entry: NotificationCatalogEntry, stream: String): List<String> =
    NOTIFICATION_CHANNELS.filter { it in entry.allowedChannels && streamEffectiveChannel(matrix, entry.key, stream, it) }

/**
 * The notifications a user can receive on [stream]: the entry serves that stream, the
 * stream's gate is on, and at least one channel is offered on it. Drives the "As the
 * owner" (business stream) and "As the Auntie" (staff stream) sections. Pure; tested.
 */
fun adminVisibleNotifications(matrix: NotificationMatrix, stream: String): List<NotificationCatalogEntry> =
    matrix.catalog.filter {
        stream in it.audiences &&
            streamEffectiveEnabled(matrix, it.key, stream) &&
            adminGateEnabledChannels(matrix, it, stream).isNotEmpty()
    }

/**
 * True when a channel is forced on for [stream]'s recipients and the user cannot change
 * it: the business locked it for that stream (locked[channel] or lockedEnabled, stream
 * overlay falling back to flat) or the catalog requires it. These mirror the cases
 * where resolveChannels ignores the user's per-channel pref. Pure; tested.
 */
fun adminChannelForced(matrix: NotificationMatrix, entry: NotificationCatalogEntry, stream: String, channel: String): Boolean =
    entry.channelLocked(channel) ||
        streamEffectiveLockedEnabled(matrix, entry.key, stream) ||
        streamEffectiveChannelLocked(matrix, entry.key, stream, channel)

/**
 * Plain-language reason a forced channel is read-only (shown next to the required
 * pill): the operator's own lock reason when they wrote one, else the stock line for
 * catalog-required vs business-locked. Pure; tested.
 */
fun adminChannelReason(matrix: NotificationMatrix, entry: NotificationCatalogEntry, channel: String): String =
    lockReasonFor(matrix, entry.key)
        ?: if (entry.channelLocked(channel)) "Always on for this notification."
        else "Locked on by your business settings."

interface AdminNotificationPrefsRepository {
    suspend fun get(): WriteResult<AdminNotificationPrefs>
    suspend fun save(prefs: AdminNotificationPrefs): WriteResult<Unit>
}

/**
 * Production impl. Mirrors [CloudNotificationOverridesRepository]: hand-built JSON
 * payloads, decode through a lenient [Json] so new backend fields never crash the
 * wasm client. Fail-loud: callable + decode errors surface as [WriteResult.Err].
 */
class CloudAdminNotificationPrefsRepository(
    private val invoke: suspend (name: String, payloadJson: String) -> WriteResult<String> = ::platformInvokeCallable,
) : AdminNotificationPrefsRepository {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    override suspend fun get(): WriteResult<AdminNotificationPrefs> =
        when (val r = invoke("getMyAdminNotificationPrefs", "{}")) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(decodePrefsEnvelope(json.parseToJsonElement(r.value).jsonObject))
            }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
        }

    override suspend fun save(prefs: AdminNotificationPrefs): WriteResult<Unit> {
        val payload = buildJsonObject { put("prefs", encodePrefs(prefs)) }
        return when (val r = invoke("saveMyAdminNotificationPrefs", json.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> WriteResult.Ok(Unit)
        }
    }

    /** Decodes the `{ prefs, updatedAtMs }` envelope returned by getMyAdminNotificationPrefs. */
    private fun decodePrefsEnvelope(obj: JsonObject): AdminNotificationPrefs {
        val prefs = obj["prefs"] as? JsonObject ?: return AdminNotificationPrefs()
        return AdminNotificationPrefs(
            byKey = decodeChannelMap(prefs["byKey"] as? JsonObject),
            byCategory = decodeChannelMap(prefs["byCategory"] as? JsonObject),
            marketingOptIn = (prefs["marketingOptIn"] as? JsonObject)?.entries
                ?.associate { (k, v) -> k to (v.jsonPrimitive.booleanOrNull ?: false) } ?: emptyMap(),
        )
    }

    private fun decodeChannelMap(obj: JsonObject?): Map<String, ChannelPrefs> =
        obj?.entries?.associate { (k, v) -> k to decodeChannelPrefs(v.jsonObject) } ?: emptyMap()

    private fun decodeChannelPrefs(o: JsonObject): ChannelPrefs = ChannelPrefs(
        email = o["email"]?.jsonPrimitive?.booleanOrNull,
        sms = o["sms"]?.jsonPrimitive?.booleanOrNull,
        push = o["push"]?.jsonPrimitive?.booleanOrNull,
    )

    private fun encodePrefs(p: AdminNotificationPrefs): JsonObject = buildJsonObject {
        if (p.byKey.isNotEmpty()) put("byKey", encodeChannelMap(p.byKey))
        if (p.byCategory.isNotEmpty()) put("byCategory", encodeChannelMap(p.byCategory))
        if (p.marketingOptIn.isNotEmpty()) {
            put("marketingOptIn", buildJsonObject { p.marketingOptIn.forEach { (k, v) -> put(k, JsonPrimitive(v)) } })
        }
    }

    private fun encodeChannelMap(m: Map<String, ChannelPrefs>): JsonObject = buildJsonObject {
        m.forEach { (k, v) ->
            val encoded = encodeChannelPrefs(v)
            if (encoded.isNotEmpty()) put(k, encoded)
        }
    }

    // Only emit channels the user actually set (a partial map; the backend zod allows it).
    private fun encodeChannelPrefs(cp: ChannelPrefs): JsonObject = buildJsonObject {
        cp.email?.let { put("email", JsonPrimitive(it)) }
        cp.sms?.let { put("sms", JsonPrimitive(it)) }
        cp.push?.let { put("push", JsonPrimitive(it)) }
    }
}
