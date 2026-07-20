package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * Phase 15.2 + 2026-07 streams revamp, admin notification-type × channel matrix.
 *
 * Wraps the business notification-override callables:
 *   - getBusinessNotificationOverrides -> catalog + current overrides
 *   - saveBusinessNotificationOverride -> persist one key's override
 *   - deleteBusinessNotificationOverride -> revert one key to its catalog default
 *
 * The catalog defines, per notification key: which recipient STREAMS it serves
 * (business / staff / kinfolk, see [NotificationCatalogEntry.audiences]), which
 * channels are allowed, which are catalog-required, and whether the whole notification
 * is alwaysEnabled. An *override* stores deviations from the catalog default: flat
 * fields (legacy, applying to every stream) plus per-stream [StreamGate] overlays and
 * an operator-facing [NotificationOverride.lockReason]. The effective gate value for a
 * stream is a FIELD-level fallback: `streams[S].field ?? flat field ?? default`, see
 * [streamEffectiveEnabled] and friends.
 */

/** The three recipient stream names used on the wire. */
const val STREAM_BUSINESS = "business"
const val STREAM_STAFF = "staff"
const val STREAM_KINFOLK = "kinfolk"

/**
 * Legacy single-audience -> streams mapping, used only when the backend has not sent
 * the newer per-entry `audiences` object. Unknown values fall back to kinfolk so an
 * entry is never dropped from the UI. The legacy field never maps to staff; staff only
 * arrives via the backend `audiences` object.
 */
fun legacyAudienceStreams(audience: String): Set<String> = when (audience.trim().lowercase()) {
    "business" -> setOf(STREAM_BUSINESS)
    "kinfolk" -> setOf(STREAM_KINFOLK)
    "both" -> setOf(STREAM_KINFOLK, STREAM_BUSINESS)
    else -> setOf(STREAM_KINFOLK)
}

/** One notification type from the server catalog. */
data class NotificationCatalogEntry(
    val key: String,
    /** Short human row title from the catalog (see [displayTitle] for the fallback chain). */
    val label: String = "",
    val category: String = "",
    /** Legacy single-audience field; superseded by [audiences] when the backend sends it. */
    val audience: String = "",
    val allowedChannels: List<String> = emptyList(),
    /** channel -> true when that channel is catalog-required (locked on). */
    val required: Map<String, Boolean> = emptyMap(),
    val alwaysEnabled: Boolean = false,
    /**
     * Streams [alwaysEnabled] applies to. Empty = it applies to EVERY stream the key
     * serves (the pre-streams behavior); see [alwaysEnabledFor].
     */
    val alwaysEnabledStreams: Set<String> = emptySet(),
    val kinfolkFacing: Boolean = false,
    val deliveryMode: String = "",
    val description: String = "",
    val marketingCategory: String? = null,
    /**
     * The recipient streams this notification serves (subset of business/staff/kinfolk,
     * never business+staff together). Decoded from the backend `audiences` object keys
     * when present; otherwise derived from the legacy [audience] field.
     */
    val audiences: Set<String> = legacyAudienceStreams(audience),
)

/**
 * Per-stream overlay on a [NotificationOverride]. Every field is optional: a null /
 * missing field falls back to the corresponding flat field on the override.
 */
data class StreamGate(
    val enabled: Boolean? = null,
    /** channel -> on/off. Missing channel = inherit the flat channel value. */
    val channels: Map<String, Boolean> = emptyMap(),
    /** Tri-state on the wire: true locks, false unlocks JUST this stream, null inherits flat. */
    val lockedEnabled: Boolean? = null,
    /** channel -> locked. Only `true` ever goes on the wire (backend literal-true schema). */
    val locked: Map<String, Boolean> = emptyMap(),
)

/** Stored deviation from a catalog default for one notification key. */
data class NotificationOverride(
    val enabled: Boolean = true,
    /** channel -> on/off. Missing channel = inherit catalog default (on). */
    val channels: Map<String, Boolean> = emptyMap(),
    /** Run-4 #13: admin pinned the whole on/off so the recipient can't change it. */
    val lockedEnabled: Boolean = false,
    /** Run-4 #13: channel -> admin-locked. A locked channel can't be changed by the recipient. */
    val locked: Map<String, Boolean> = emptyMap(),
    /**
     * Operator's plain-language reason a locked notification stays on. Always flat
     * (one reason per key, not per stream). On the wire: null = leave untouched,
     * "" = explicit clear, max 300 chars.
     */
    val lockReason: String? = null,
    /** Per-stream gate overlays keyed by stream name (business / staff / kinfolk). */
    val streams: Map<String, StreamGate> = emptyMap(),
)

/** Full matrix snapshot: the catalog plus any saved overrides. */
data class NotificationMatrix(
    val catalog: List<NotificationCatalogEntry> = emptyList(),
    val overrides: Map<String, NotificationOverride> = emptyMap(),
    val updatedAtMs: Long? = null,
) {
    /** FLAT effective on/off for a whole notification key (override wins; default = on). */
    fun effectiveEnabled(key: String): Boolean =
        overrides[key]?.enabled ?: true

    /** FLAT effective on/off for one channel of a key (override wins; default = on). */
    fun effectiveChannel(key: String, channel: String): Boolean =
        overrides[key]?.channels?.get(channel) ?: true

    /** FLAT: admin has pinned the whole-notification on/off. */
    fun effectiveLockedEnabled(key: String): Boolean =
        overrides[key]?.lockedEnabled ?: false

    /** FLAT: admin has pinned this channel's on/off. */
    fun effectiveChannelLocked(key: String, channel: String): Boolean =
        overrides[key]?.locked?.get(channel) ?: false
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-stream effective state (field-level fallback: stream ?? flat ?? default)
// ─────────────────────────────────────────────────────────────────────────────

/** Effective on/off of [key] for [stream]'s recipients: stream gate wins, else flat. */
fun streamEffectiveEnabled(matrix: NotificationMatrix, key: String, stream: String): Boolean =
    matrix.overrides[key]?.streams?.get(stream)?.enabled ?: matrix.effectiveEnabled(key)

/** Effective on/off of one channel of [key] for [stream]: stream gate wins, else flat. */
fun streamEffectiveChannel(matrix: NotificationMatrix, key: String, stream: String, channel: String): Boolean =
    matrix.overrides[key]?.streams?.get(stream)?.channels?.get(channel) ?: matrix.effectiveChannel(key, channel)

/** Effective whole-notification lock of [key] for [stream]: stream gate wins, else flat. */
fun streamEffectiveLockedEnabled(matrix: NotificationMatrix, key: String, stream: String): Boolean =
    matrix.overrides[key]?.streams?.get(stream)?.lockedEnabled ?: matrix.effectiveLockedEnabled(key)

/** Effective channel lock of [key] for [stream]: stream gate wins, else flat. */
fun streamEffectiveChannelLocked(matrix: NotificationMatrix, key: String, stream: String, channel: String): Boolean =
    matrix.overrides[key]?.streams?.get(stream)?.locked?.get(channel) ?: matrix.effectiveChannelLocked(key, channel)

/** The operator's lock reason for [key] (always flat; blank means none). */
fun lockReasonFor(matrix: NotificationMatrix, key: String): String? =
    matrix.overrides[key]?.lockReason?.takeIf { it.isNotBlank() }

// ─────────────────────────────────────────────────────────────────────────────
// Write-side helpers (what the gate UI persists when a row is edited under a tab)
// ─────────────────────────────────────────────────────────────────────────────

/** A copy with stream [stream]'s gate transformed (created empty when absent). */
fun NotificationOverride.withStreamGate(stream: String, transform: (StreamGate) -> StreamGate): NotificationOverride =
    copy(streams = streams + (stream to transform(streams[stream] ?: StreamGate())))

/**
 * The next full override after toggling [channel]'s lock under [stream]'s tab.
 * Locking is a plain per-stream write. UNLOCKING is trickier: the wire only accepts
 * literal-true lock-map values, so a flat (legacy) lock cannot be overridden with
 * false. Instead the flat lock is cleared and first materialized as an explicit
 * stream lock on every OTHER stream the entry serves, so their effective state
 * never changes.
 */
fun toggledStreamChannelLock(
    matrix: NotificationMatrix,
    entry: NotificationCatalogEntry,
    stream: String,
    channel: String,
): NotificationOverride {
    val base = matrix.overrides[entry.key] ?: NotificationOverride()
    val currentlyLocked = streamEffectiveChannelLocked(matrix, entry.key, stream, channel)
    if (!currentlyLocked) {
        return base.withStreamGate(stream) { it.copy(locked = it.locked + (channel to true)) }
    }
    var next = base
    if (base.locked[channel] == true) {
        entry.audiences.filter { it != stream }.forEach { other ->
            if (streamEffectiveChannelLocked(matrix, entry.key, other, channel)) {
                next = next.withStreamGate(other) { it.copy(locked = it.locked + (channel to true)) }
            }
        }
        next = next.copy(locked = next.locked - channel)
    }
    return next.withStreamGate(stream) { it.copy(locked = it.locked - channel) }
}

/**
 * The next full override after toggling the whole-notification lock under [stream]'s
 * tab. lockedEnabled is tri-state on the wire, so an explicit stream-level false is
 * enough to unlock one stream while a flat lock keeps the others locked.
 */
fun toggledStreamEnabledLock(
    matrix: NotificationMatrix,
    entry: NotificationCatalogEntry,
    stream: String,
): NotificationOverride {
    val base = matrix.overrides[entry.key] ?: NotificationOverride()
    val currentlyLocked = streamEffectiveLockedEnabled(matrix, entry.key, stream)
    return base.withStreamGate(stream) { it.copy(lockedEnabled = !currentlyLocked) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Audience taxonomy (the ONE grouping for gate tabs + admin prefs sections)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three recipient audiences the notification gate is organized around. ONE
 * taxonomy for both the Settings gate tabs and the admin's own prefs screen
 * (replaces the old NotifTab + NotificationBucket dual system). Populated purely
 * from [NotificationCatalogEntry.audiences].
 */
enum class NotifAudience(val order: Int, val title: String, val stream: String) {
    Business(0, "Business", STREAM_BUSINESS),
    Staff(1, "Staff (Auntie)", STREAM_STAFF),
    Kinfolk(2, "Kinfolk", STREAM_KINFOLK),
}

/** Which audience tab(s) an entry appears under: exactly the streams it serves. */
fun NotificationCatalogEntry.notifAudiences(): Set<NotifAudience> =
    NotifAudience.entries.filterTo(linkedSetOf()) { it.stream in audiences }

/**
 * One short line for a shared key, naming the OTHER copy (e.g. under the Business tab
 * a booking key that families also receive reads "Kinfolk get their own copy of this
 * one"). Null when the entry serves only the current audience. The backend never
 * pairs business with staff, so there is at most one other audience.
 */
fun sharedCopyCaption(entry: NotificationCatalogEntry, current: NotifAudience): String? {
    val audiences = entry.notifAudiences()
    if (current !in audiences) return null
    return when ((audiences - current).firstOrNull()) {
        NotifAudience.Kinfolk -> "Kinfolk get their own copy of this one"
        NotifAudience.Business -> "The owner gets their own copy of this one"
        NotifAudience.Staff -> "Your Aunties get their own copy of this one"
        null -> null
    }
}

/** The whole-notification toggle is locked when the catalog marks it alwaysEnabled. */
fun NotificationCatalogEntry.enabledLocked(): Boolean = alwaysEnabled

/** A channel toggle is locked when the catalog marks that channel required. */
fun NotificationCatalogEntry.channelLocked(channel: String): Boolean = required[channel] == true

/**
 * Whether alwaysEnabled applies to [stream]'s copy: an empty [alwaysEnabledStreams]
 * scopes it to every stream the key serves (legacy flat behavior).
 */
fun NotificationCatalogEntry.alwaysEnabledFor(stream: String): Boolean =
    alwaysEnabled && (alwaysEnabledStreams.isEmpty() || stream in alwaysEnabledStreams)

/** The row title shown in the gate matrix and My Notifications: label, else description, else key. */
fun NotificationCatalogEntry.displayTitle(): String = label.ifBlank { description.ifBlank { key } }

// ─────────────────────────────────────────────────────────────────────────────
// Workflow sections (the ONE grouping for the gate matrix + My Notifications)
// ─────────────────────────────────────────────────────────────────────────────

/** One workflow section: a heading plus the catalog categories it collects. */
data class NotifSection(val title: String, val categories: List<String>)

/** Trailing catch-all for entries whose category matches no section (never drop a row). */
private val NOTIF_SECTION_OTHER = NotifSection("Other", emptyList())

/** The ordered workflow sections for one audience, phrased for that audience's day. */
fun notifSections(audience: NotifAudience): List<NotifSection> = when (audience) {
    NotifAudience.Business -> listOf(
        NotifSection("Bookings and visits", listOf("visit")),
        NotifSection("Messages", listOf("messages")),
        NotifSection("Billing and payments", listOf("invoice")),
        NotifSection("Ratings and pets", listOf("ratings")),
        NotifSection("Account and security", listOf("account", "security")),
    )
    NotifAudience.Staff -> listOf(
        NotifSection("Assignments and schedule", listOf("schedule")),
        NotifSection("Visit workflow", listOf("visit")),
        NotifSection("KinTales and comments", listOf("kintale")),
        NotifSection("Pets and profiles", listOf("home")),
    )
    NotifAudience.Kinfolk -> listOf(
        NotifSection("Visit updates", listOf("visit")),
        NotifSection("Upcoming care", listOf("schedule")),
        NotifSection("KinTales", listOf("kintale")),
        NotifSection("Billing and payments", listOf("invoice")),
        NotifSection("Home and pets", listOf("home")),
        NotifSection("Account and security", listOf("account", "security")),
        NotifSection("Newsletters and community", listOf("marketing")),
    )
}

/**
 * Buckets [entries] into [audience]'s sections, preserving the incoming (catalog)
 * order within each. Unmatched categories land in a trailing "Other" section; empty
 * sections are dropped.
 */
fun sectionedNotifications(
    entries: List<NotificationCatalogEntry>,
    audience: NotifAudience,
): List<Pair<NotifSection, List<NotificationCatalogEntry>>> {
    val sections = notifSections(audience)
    val claimed = sections.flatMap { it.categories }.toSet()
    return (sections.map { sec -> sec to entries.filter { it.category in sec.categories } } +
        (NOTIF_SECTION_OTHER to entries.filter { it.category !in claimed }))
        .filter { (_, rows) -> rows.isNotEmpty() }
}

interface NotificationOverridesRepository {
    suspend fun getMatrix(): WriteResult<NotificationMatrix>
    suspend fun saveOverride(key: String, override: NotificationOverride): WriteResult<Unit>
    suspend fun deleteOverride(key: String): WriteResult<Unit>
}

/**
 * Production impl. Mirrors [CloudFormSchemaRepository]: hand-built JSON payloads,
 * decode through a lenient [Json] so new backend fields never crash the wasm client.
 */
class CloudNotificationOverridesRepository(
    private val invoke: suspend (name: String, payloadJson: String) -> WriteResult<String> = ::platformInvokeCallable,
) : NotificationOverridesRepository {

    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    override suspend fun getMatrix(): WriteResult<NotificationMatrix> =
        when (val r = invoke("getBusinessNotificationOverrides", "{}")) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> runCatching {
                WriteResult.Ok(decodeMatrix(json.parseToJsonElement(r.value).jsonObject))
            }.getOrElse { WriteResult.Err(it.message ?: "decode failed") }
        }

    override suspend fun saveOverride(key: String, override: NotificationOverride): WriteResult<Unit> {
        val payload = buildJsonObject {
            put("key", JsonPrimitive(key))
            put("override", encodeOverride(override))
        }
        return when (val r = invoke("saveBusinessNotificationOverride", json.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> WriteResult.Ok(Unit)
        }
    }

    override suspend fun deleteOverride(key: String): WriteResult<Unit> {
        val payload = buildJsonObject { put("key", JsonPrimitive(key)) }
        return when (val r = invoke("deleteBusinessNotificationOverride", json.encodeToString(JsonObject.serializer(), payload))) {
            is WriteResult.Err -> WriteResult.Err(r.message)
            is WriteResult.Ok -> WriteResult.Ok(Unit)
        }
    }

    private fun encodeOverride(o: NotificationOverride): JsonObject = buildJsonObject {
        put("enabled", JsonPrimitive(o.enabled))
        if (o.channels.isNotEmpty()) {
            put("channels", buildJsonObject { o.channels.forEach { (k, v) -> put(k, JsonPrimitive(v)) } })
        }
        // Run-4 #13: flat locks are literal-true on the wire (lockedEnabled true /
        // locked[channel] true). Sending `false` would fail the `z.literal(true)` schema.
        if (o.lockedEnabled) put("lockedEnabled", JsonPrimitive(true))
        val onLocks = o.locked.filterValues { it }
        if (onLocks.isNotEmpty()) {
            put("locked", buildJsonObject { onLocks.forEach { (k, _) -> put(k, JsonPrimitive(true)) } })
        }
        // lockReason is always flat; null = leave untouched (absent), "" = explicit clear.
        o.lockReason?.let { put("lockReason", JsonPrimitive(it)) }
        val gates = o.streams.mapValues { (_, g) -> encodeStreamGate(g) }.filterValues { it.isNotEmpty() }
        if (gates.isNotEmpty()) {
            put("streams", buildJsonObject { gates.forEach { (s, g) -> put(s, g) } })
        }
    }

    private fun encodeStreamGate(g: StreamGate): JsonObject = buildJsonObject {
        g.enabled?.let { put("enabled", JsonPrimitive(it)) }
        if (g.channels.isNotEmpty()) {
            put("channels", buildJsonObject { g.channels.forEach { (k, v) -> put(k, JsonPrimitive(v)) } })
        }
        // lockedEnabled is tri-state (false = unlock just this stream); the locked map
        // stays literal-true only, false entries never go on the wire.
        g.lockedEnabled?.let { put("lockedEnabled", JsonPrimitive(it)) }
        val onLocks = g.locked.filterValues { it }
        if (onLocks.isNotEmpty()) {
            put("locked", buildJsonObject { onLocks.forEach { (k, _) -> put(k, JsonPrimitive(true)) } })
        }
    }

    private fun decodeMatrix(obj: JsonObject): NotificationMatrix {
        val catalog = (obj["catalog"] as? JsonArray)?.map { decodeCatalogEntry(it.jsonObject) } ?: emptyList()
        val overrides = (obj["overrides"] as? JsonObject)?.entries
            ?.associate { (k, v) -> k to decodeOverride(v.jsonObject) } ?: emptyMap()
        val updatedAtMs = obj["updatedAtMs"]?.jsonPrimitive?.longOrNull
        return NotificationMatrix(catalog, overrides, updatedAtMs)
    }

    private fun decodeCatalogEntry(o: JsonObject): NotificationCatalogEntry {
        val legacyAudience = o["audience"]?.jsonPrimitive?.contentOrNull.orEmpty()
        return NotificationCatalogEntry(
            key = o["key"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            label = o["label"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            category = o["category"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            audience = legacyAudience,
            allowedChannels = (o["allowedChannels"] as? JsonArray)?.map { it.jsonPrimitive.content } ?: emptyList(),
            required = (o["required"] as? JsonObject)?.entries
                ?.associate { (k, v) -> k to (v.jsonPrimitive.booleanOrNull ?: false) } ?: emptyMap(),
            alwaysEnabled = o["alwaysEnabled"]?.jsonPrimitive?.booleanOrNull ?: false,
            // Missing object = empty set = alwaysEnabled covers every served stream.
            alwaysEnabledStreams = (o["alwaysEnabledStreams"] as? JsonObject)?.entries
                ?.filter { (_, v) -> v.jsonPrimitive.booleanOrNull == true }
                ?.map { it.key }?.toSet() ?: emptySet(),
            kinfolkFacing = o["kinfolkFacing"]?.jsonPrimitive?.booleanOrNull ?: false,
            deliveryMode = o["deliveryMode"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            description = o["description"]?.jsonPrimitive?.contentOrNull.orEmpty(),
            marketingCategory = o["marketingCategory"]?.jsonPrimitive?.contentOrNull,
            // The backend's audiences object wins; a missing or degenerate-empty one
            // falls back to the legacy single-audience mapping (never drop an entry).
            audiences = (o["audiences"] as? JsonObject)?.entries
                ?.filter { (_, v) -> v.jsonPrimitive.booleanOrNull == true }
                ?.map { it.key }?.toSet()
                ?.takeIf { it.isNotEmpty() }
                ?: legacyAudienceStreams(legacyAudience),
        )
    }

    private fun decodeOverride(o: JsonObject): NotificationOverride = NotificationOverride(
        enabled = o["enabled"]?.jsonPrimitive?.booleanOrNull ?: true,
        channels = (o["channels"] as? JsonObject)?.entries
            ?.associate { (k, v) -> k to (v.jsonPrimitive.booleanOrNull ?: false) } ?: emptyMap(),
        lockedEnabled = o["lockedEnabled"]?.jsonPrimitive?.booleanOrNull ?: false,
        locked = (o["locked"] as? JsonObject)?.entries
            ?.associate { (k, v) -> k to (v.jsonPrimitive.booleanOrNull ?: false) } ?: emptyMap(),
        lockReason = o["lockReason"]?.jsonPrimitive?.contentOrNull,
        streams = (o["streams"] as? JsonObject)?.entries
            ?.associate { (k, v) -> k to decodeStreamGate(v.jsonObject) } ?: emptyMap(),
    )

    private fun decodeStreamGate(o: JsonObject): StreamGate = StreamGate(
        enabled = o["enabled"]?.jsonPrimitive?.booleanOrNull,
        channels = (o["channels"] as? JsonObject)?.entries
            ?.associate { (k, v) -> k to (v.jsonPrimitive.booleanOrNull ?: false) } ?: emptyMap(),
        lockedEnabled = o["lockedEnabled"]?.jsonPrimitive?.booleanOrNull,
        locked = (o["locked"] as? JsonObject)?.entries
            ?.associate { (k, v) -> k to (v.jsonPrimitive.booleanOrNull ?: false) } ?: emptyMap(),
    )
}
