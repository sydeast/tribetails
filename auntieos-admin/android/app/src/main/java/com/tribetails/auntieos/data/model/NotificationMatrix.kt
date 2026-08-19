package com.tribetails.auntieos.data.model

/**
 * Phase 15.2 + notification-settings revamp, admin notification-type x channel matrix
 * (Android mirror of the web model). Backed by the businessNotificationOverride
 * callables. An *override* stores only deviations from the catalog default (enabled +
 * all allowed channels on), so the effective state is `override ?: catalog default`.
 *
 * Revamp taxonomy: every catalog key fans out to one or more STREAMS.
 *  - business = owner-hat ops (bookings, invoices, payments, security, ratings)
 *  - staff    = Auntie-hat workflow (visit notes, KinTale comments, pet updates, digest)
 *  - kinfolk  = the families' copies (confirmations, arrivals, reports, receipts)
 * Overrides may carry per-stream gates ([StreamGate]); the effective value for a stream
 * uses FIELD-level fallback: streams[S].enabled ?? flat enabled, and per channel
 * streams[S].channels[ch] ?? flat channels[ch] (same for lockedEnabled/locked).
 */

/** Wire keys for the three notification streams. */
const val STREAM_BUSINESS = "business"
const val STREAM_STAFF = "staff"
const val STREAM_KINFOLK = "kinfolk"

/** Legacy `audience` string -> stream set, for catalog docs without `audiences`.
 *  Unknown values fall back to kinfolk so nothing is ever dropped from the UI. */
fun legacyAudienceSet(audience: String): Set<String> = when (audience.trim().lowercase()) {
    "business" -> setOf(STREAM_BUSINESS)
    "kinfolk" -> setOf(STREAM_KINFOLK)
    "both" -> setOf(STREAM_KINFOLK, STREAM_BUSINESS)
    else -> setOf(STREAM_KINFOLK)
}

/** One call site that dispatches a catalog key (#396). Server-authored English. */
data class NotificationEmitter(
    /** What happens in the business to set this off, in plain words. */
    val trigger: String = "",
    /** Where it lives, relative to mytribe/functions/. */
    val source: String = "",
    /** The keys that call site puts in the merge bag. This is the leak surface. */
    val dataKeys: List<String> = emptyList(),
    /** Set when the listed keys are not the whole story. */
    val dataNote: String? = null,
)
/** One outbound email the notification gate does NOT govern (#396). */
data class UngatedSend(
    val templateId: String = "",
    val trigger: String = "",
    val source: String = "",
)
/** One notification type from the server catalog. */
data class NotificationCatalogEntry(
    val key: String,
    /** Short human row title from the catalog (e.g. "KinTale (visit report) published"). */
    val label: String = "",
    val category: String = "",
    val audience: String = "",
    val allowedChannels: List<String> = emptyList(),
    /** channel -> true when that channel is catalog-required (locked on). */
    val required: Map<String, Boolean> = emptyMap(),
    val alwaysEnabled: Boolean = false,
    /** Streams alwaysEnabled applies to; empty = every stream the key serves. */
    val alwaysEnabledStreams: Set<String> = emptySet(),
    val kinfolkFacing: Boolean = false,
    val deliveryMode: String = "",
    val description: String = "",
    val marketingCategory: String? = null,
    /** Streams this key fans out to (business/staff/kinfolk; subset, >=1; never
     *  business+staff together). Server-sent; defaults from the legacy audience. */
    val audiences: Set<String> = legacyAudienceSet(audience),
    // ── #396 provenance. Every one defaults to empty, so a payload from a
    // backend that predates the projection still parses and simply has nothing
    // to show. The two sides deploy separately.
    /** Who it reaches, one server-written sentence per resolver in play. */
    val whoReceives: List<String> = emptyList(),
    val recipientResolver: String = "",
    val secondaryResolver: String? = null,
    /** Every call site that dispatches this key. Empty when nothing does. */
    val emitters: List<NotificationEmitter> = emptyList(),
    /** True when NO code fires this key, so its toggles control nothing. */
    val neverFires: Boolean = false,
    /**
     * channel -> the `${'$'}{channel}Templates/{id}` document that ACTUALLY renders
     * it. Email is the EFFECTIVE id after `notificationTemplateBindings`, not
     * the catalog default, because the gate can retarget an email and naming the
     * catalog document on a retargeted row would report the wrong body.
     */
    val templates: Map<String, String> = emptyMap(),
    /** The catalog default email template, when a binding has moved email off it. */
    val emailTemplateRetargetedFrom: String? = null,
    /** Merge fields the server hydrates for this key's templates. */
    val mergeFields: List<String> = emptyList(),
    /** True when an outside system delivers it and this gate controls nothing. */
    val external: Boolean = false,
) {
    /**
     * ADVISORY, NOT A LOCK (#396). This says the catalog marks the notification
     * too important to silence. It does NOT mean the operator cannot silence
     * it: `resolveChannels` in MyTribe functions has no alwaysEnabled check at
     * all, deliberately, since ruling #7 (2026-06-08, warn-but-allow-off). The
     * gate matrix must therefore never disable its On/Off toggle off this
     * value, or Android would enforce a rule the server does not and the same
     * operator would get two different answers on two devices. It renders as a
     * risk badge instead; see [notifAlwaysOnBadge].
     */
    fun enabledLocked(): Boolean = alwaysEnabled

    /**
     * Is this notification always on for [stream]? alwaysEnabled, scoped by
     * alwaysEnabledStreams: an empty set means every stream the key serves.
     */
    fun alwaysEnabledFor(stream: String): Boolean =
        alwaysEnabled && (alwaysEnabledStreams.isEmpty() || stream in alwaysEnabledStreams)

    /** Row title for the UI: the catalog label, else the description, else the key. */
    fun displayTitle(): String = label.ifBlank { description.ifBlank { key } }

    /** A channel toggle is locked when the catalog marks that channel required. */
    fun channelLocked(channel: String): Boolean = required[channel] == true
}

/** One stream's deviation from the flat override (all fields optional = inherit flat). */
data class StreamGate(
    val enabled: Boolean? = null,
    /** channel -> on/off. Missing channel = inherit the flat channel value. */
    val channels: Map<String, Boolean> = emptyMap(),
    val lockedEnabled: Boolean? = null,
    /** channel -> locked. Missing channel = inherit the flat lock. */
    val locked: Map<String, Boolean> = emptyMap(),
) {
    fun isEmpty(): Boolean =
        enabled == null && channels.isEmpty() && lockedEnabled == null && locked.isEmpty()
}

/** Stored deviation from a catalog default for one notification key. */
data class NotificationOverride(
    val enabled: Boolean = true,
    /** channel -> on/off. Missing channel = inherit catalog default (on). */
    val channels: Map<String, Boolean> = emptyMap(),
    /** Run-4 #13: admin pinned the whole on/off so the recipient can't change it. */
    val lockedEnabled: Boolean = false,
    /** Run-4 #13: channel -> admin-locked. A locked channel can't be changed by the recipient. */
    val locked: Map<String, Boolean> = emptyMap(),
    /** Operator's plain-language reason why this one stays locked on (flat, max 300). */
    val lockReason: String? = null,
    /** Per-stream gates keyed by stream ("business"/"staff"/"kinfolk"). */
    val streams: Map<String, StreamGate> = emptyMap(),
)

/** Full matrix snapshot: the catalog plus any saved overrides. */
data class NotificationMatrix(
    val catalog: List<NotificationCatalogEntry> = emptyList(),
    val overrides: Map<String, NotificationOverride> = emptyMap(),
    /** Mail the platform sends that this gate does NOT govern (#396). */
    val ungated: List<UngatedSend> = emptyList(),
    /** How many people a `businessAdmins` row reaches now. Null = unreadable. */
    val businessAdminCount: Int? = null,
    /** Where that roster lives, so the number is checkable. */
    val businessAdminRosterPath: String = "",
    val updatedAtMs: Long? = null,
) {
    /** Effective FLAT on/off for a whole notification key (override wins; default = on). */
    fun effectiveEnabled(key: String): Boolean = overrides[key]?.enabled ?: true

    /** Effective FLAT on/off for one channel of a key (override wins; default = on). */
    fun effectiveChannel(key: String, channel: String): Boolean =
        overrides[key]?.channels?.get(channel) ?: true

    /** FLAT: admin has pinned the whole-notification on/off (recipient can't change). */
    fun effectiveLockedEnabled(key: String): Boolean = overrides[key]?.lockedEnabled ?: false

    /** FLAT: admin has pinned this channel's on/off (recipient can't change). */
    fun effectiveChannelLocked(key: String, channel: String): Boolean =
        overrides[key]?.locked?.get(channel) ?: false

    // ── stream-effective values (field-level fallback onto the flat override) ──

    /** Effective on/off for [stream]: streams[S].enabled ?? flat enabled ?? on. */
    fun streamEffectiveEnabled(key: String, stream: String): Boolean {
        val o = overrides[key] ?: return true
        return o.streams[stream]?.enabled ?: o.enabled
    }

    /** Effective channel on/off for [stream]: streams[S].channels[ch] ?? flat ?? on. */
    fun streamEffectiveChannel(key: String, stream: String, channel: String): Boolean {
        val o = overrides[key] ?: return true
        return o.streams[stream]?.channels?.get(channel) ?: o.channels[channel] ?: true
    }

    /** Effective whole-notification lock for [stream]: streams[S] ?? flat ?? off. */
    fun streamEffectiveLockedEnabled(key: String, stream: String): Boolean {
        val o = overrides[key] ?: return false
        return o.streams[stream]?.lockedEnabled ?: o.lockedEnabled
    }

    /** Effective channel lock for [stream]: streams[S].locked[ch] ?? flat ?? off. */
    fun streamEffectiveChannelLocked(key: String, stream: String, channel: String): Boolean {
        val o = overrides[key] ?: return false
        return o.streams[stream]?.locked?.get(channel) ?: o.locked[channel] ?: false
    }

    /** The operator's lock reason for [key], or null when blank/absent. */
    fun lockReasonFor(key: String): String? =
        overrides[key]?.lockReason?.trim()?.takeIf { it.isNotEmpty() }
}

// ─────────────────────────────────────────────────────────────────────────────
// Audience tabs (the gate) - one enum driven by the catalog's audiences set
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three audience tabs of the notification gate, one per stream. Shared keys
 * (e.g. audiences {kinfolk, business}) appear under EACH of their audiences.
 * Staff displays as "Auntie": it is the operator's hands-on workflow hat.
 */
enum class NotifAudience(val order: Int, val title: String, val streamKey: String) {
    Business(0, "Business", STREAM_BUSINESS),
    Staff(1, "Auntie", STREAM_STAFF),
    Kinfolk(2, "Kinfolk", STREAM_KINFOLK),
}

/** Does [this] entry belong under audience [a]? */
fun NotificationCatalogEntry.inAudience(a: NotifAudience): Boolean = a.streamKey in audiences

/**
 * Muted one-liner shown on shared keys, naming the OTHER copy of the notification.
 * Null when the key lives in a single audience. business+staff never co-occur, so at
 * most one other audience exists; if the contract is ever violated we still name each.
 */
fun sharedCopyCaption(audiences: Set<String>, current: NotifAudience): String? {
    val others = audiences - current.streamKey
    if (audiences.size <= 1 || others.isEmpty()) return null
    val parts = NotifAudience.entries.sortedBy { it.order }.mapNotNull { a ->
        if (a.streamKey !in others) return@mapNotNull null
        when (a) {
            NotifAudience.Kinfolk -> "Kinfolk get their own copy (Kinfolk tab)."
            NotifAudience.Business -> "You get an owner copy too (Business tab)."
            NotifAudience.Staff -> "You get an Auntie copy too (Auntie tab)."
        }
    }
    return parts.joinToString(" ").takeIf { it.isNotEmpty() }
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow sections (the ONE row grouping for the gate matrix + prefs screens)
// ─────────────────────────────────────────────────────────────────────────────

/** One workflow section: a heading plus the catalog categories it collects. */
data class NotifSection(val title: String, val categories: List<String>)

/** Trailing catch-all section for entries whose category matches no section. */
const val NOTIF_SECTION_OTHER = "Other"

private val BUSINESS_NOTIF_SECTIONS = listOf(
    NotifSection("Bookings and visits", listOf("visit")),
    NotifSection("Messages", listOf("messages")),
    NotifSection("Billing and payments", listOf("invoice")),
    NotifSection("Ratings and pets", listOf("ratings")),
    NotifSection("Account and security", listOf("account", "security")),
)

private val STAFF_NOTIF_SECTIONS = listOf(
    NotifSection("Assignments and schedule", listOf("schedule")),
    NotifSection("Visit workflow", listOf("visit")),
    NotifSection("KinTales and comments", listOf("kintale")),
    NotifSection("Pets and profiles", listOf("home")),
)

private val KINFOLK_NOTIF_SECTIONS = listOf(
    NotifSection("Visit updates", listOf("visit")),
    NotifSection("Upcoming care", listOf("schedule")),
    NotifSection("KinTales", listOf("kintale")),
    // #386: mirrors the web taxonomy in lib/myNotificationsFormat.ts. Its only
    // row is `broadcast.message`, the office's announcement to a whole audience
    // segment, which otherwise lands in the trailing "Other" catch-all.
    NotifSection("Messages", listOf("messages")),
    NotifSection("Billing and payments", listOf("invoice")),
    NotifSection("Home and pets", listOf("home")),
    NotifSection("Account and security", listOf("account", "security")),
    NotifSection("Newsletters and community", listOf("marketing")),
)

/** Ordered workflow sections for one stream; unknown streams get none (all -> Other). */
fun notifSectionsFor(stream: String): List<NotifSection> = when (stream) {
    STREAM_BUSINESS -> BUSINESS_NOTIF_SECTIONS
    STREAM_STAFF -> STAFF_NOTIF_SECTIONS
    STREAM_KINFOLK -> KINFOLK_NOTIF_SECTIONS
    else -> emptyList()
}

/**
 * Groups [entries] under [stream]'s workflow sections, keeping the incoming order
 * inside each section. Entries whose category matches no section land in a trailing
 * "Other" section, so nothing is ever dropped. Empty sections are omitted. Pure; tested.
 */
fun sectionedNotifEntries(
    entries: List<NotificationCatalogEntry>,
    stream: String,
): List<Pair<String, List<NotificationCatalogEntry>>> {
    val sections = notifSectionsFor(stream)
    val claimed = sections.flatMap { it.categories }.toSet()
    val grouped = sections.mapNotNull { s ->
        val rows = entries.filter { it.category in s.categories }
        if (rows.isEmpty()) null else s.title to rows
    }
    val other = entries.filter { it.category !in claimed }
    return if (other.isEmpty()) grouped else grouped + (NOTIF_SECTION_OTHER to other)
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream write helpers (what the gate UI saves: streams[T] overlay, never flat)
// ─────────────────────────────────────────────────────────────────────────────

private fun NotificationOverride.gate(stream: String): StreamGate = streams[stream] ?: StreamGate()

/** Sets the whole-notification on/off for [stream] only (flat untouched). */
fun NotificationOverride.withStreamEnabled(stream: String, value: Boolean): NotificationOverride =
    copy(streams = streams + (stream to gate(stream).copy(enabled = value)))

/** Sets one channel's on/off for [stream] only (flat untouched). */
fun NotificationOverride.withStreamChannel(stream: String, channel: String, value: Boolean): NotificationOverride {
    val g = gate(stream)
    return copy(streams = streams + (stream to g.copy(channels = g.channels + (channel to value))))
}

/**
 * Sets the whole-notification LOCK for [stream]. Locks are only-true on the wire
 * (absence = unlocked), so unlocking a lock the stream inherited from the flat legacy
 * field must (a) clear the flat lock and (b) pin an explicit lock onto every OTHER
 * stream in [allStreams] that was inheriting it, preserving their effective state.
 */
fun NotificationOverride.withStreamLockedEnabled(
    stream: String,
    value: Boolean,
    allStreams: Set<String>,
): NotificationOverride {
    if (value) return copy(streams = streams + (stream to gate(stream).copy(lockedEnabled = true)))
    var next = streams + (stream to gate(stream).copy(lockedEnabled = null))
    var flat = lockedEnabled
    if (lockedEnabled) {
        (allStreams - stream).forEach { s ->
            val g = next[s] ?: StreamGate()
            if (g.lockedEnabled == null) next = next + (s to g.copy(lockedEnabled = true))
        }
        flat = false
    }
    return copy(lockedEnabled = flat, streams = next)
}

/** Sets one channel's LOCK for [stream]; same flat-migration rule as above. */
fun NotificationOverride.withStreamChannelLock(
    stream: String,
    channel: String,
    value: Boolean,
    allStreams: Set<String>,
): NotificationOverride {
    val g = gate(stream)
    if (value) {
        return copy(streams = streams + (stream to g.copy(locked = g.locked + (channel to true))))
    }
    var next = streams + (stream to g.copy(locked = g.locked - channel))
    var flat = locked
    if (locked[channel] == true) {
        (allStreams - stream).forEach { s ->
            val other = next[s] ?: StreamGate()
            if (channel !in other.locked) {
                next = next + (s to other.copy(locked = other.locked + (channel to true)))
            }
        }
        flat = locked - channel
    }
    return copy(locked = flat, streams = next)
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire parse/serialize (pure, testable; the repository delegates here)
// ─────────────────────────────────────────────────────────────────────────────

/** Parses a `{ key -> Boolean }` wire map, dropping malformed entries. */
private fun boolMap(raw: Any?): Map<String, Boolean> =
    (raw as? Map<*, *>).orEmpty().entries.mapNotNull { (k, v) ->
        val ks = k as? String ?: return@mapNotNull null
        val vb = v as? Boolean ?: return@mapNotNull null
        ks to vb
    }.toMap()

/** Decodes a wire `{ key: true }` object into its true-valued keys; absent -> empty. */
fun trueKeySet(raw: Any?): Set<String> =
    (raw as? Map<*, *>)?.entries
        ?.mapNotNull { (k, v) -> (k as? String)?.takeIf { v == true } }
        ?.toSet()
        .orEmpty()

/** Decodes the catalog `audiences` object (keys with value true); absent/empty ->
 *  legacy fallback from the flat audience string. */
fun audienceSetFromRaw(raw: Any?, legacyAudience: String): Set<String> =
    trueKeySet(raw).ifEmpty { legacyAudienceSet(legacyAudience) }

/** Parses one catalog entry from the callable payload; null when the key is missing. */
fun notificationCatalogEntryFromMap(m: Map<*, *>): NotificationCatalogEntry? {
    val key = m["key"] as? String ?: return null
    val audience = m["audience"] as? String ?: ""
    return NotificationCatalogEntry(
        key = key,
        label = m["label"] as? String ?: "",
        category = m["category"] as? String ?: "",
        audience = audience,
        allowedChannels = (m["allowedChannels"] as? List<*>).orEmpty().mapNotNull { it as? String },
        required = boolMap(m["required"]),
        alwaysEnabled = m["alwaysEnabled"] as? Boolean ?: false,
        alwaysEnabledStreams = trueKeySet(m["alwaysEnabledStreams"]),
        kinfolkFacing = m["kinfolkFacing"] as? Boolean ?: false,
        deliveryMode = m["deliveryMode"] as? String ?: "",
        description = m["description"] as? String ?: "",
        marketingCategory = m["marketingCategory"] as? String,
        audiences = audienceSetFromRaw(m["audiences"], audience),
        whoReceives = stringList(m["whoReceives"]),
        recipientResolver = m["recipientResolver"] as? String ?: "",
        secondaryResolver = m["secondaryResolver"] as? String,
        emitters = notificationEmittersFromRaw(m["emitters"]),
        neverFires = m["neverFires"] as? Boolean ?: false,
        templates = stringMap(m["templates"]),
        emailTemplateRetargetedFrom = (m["emailTemplateRetargetedFrom"] as? String)
            ?.takeIf { it.isNotBlank() },
        mergeFields = stringList(m["mergeFields"]),
        external = m["external"] as? Boolean ?: false,
    )
}
/** `["a", "b"]` -> `["a", "b"]`, skipping anything that is not a string. */
fun stringList(raw: Any?): List<String> =
    (raw as? List<*>).orEmpty().mapNotNull { it as? String }
/** `{ email: "invoice.new" }` -> the same, skipping non-string entries. */
fun stringMap(raw: Any?): Map<String, String> =
    (raw as? Map<*, *>).orEmpty().entries.mapNotNull { (k, v) ->
        val key = k as? String ?: return@mapNotNull null
        val value = v as? String ?: return@mapNotNull null
        key to value
    }.toMap()
/** Parses the server's emitter list. A row with no trigger text is dropped:
 *  an emitter that cannot say what it does is worse than no emitter shown. */
fun notificationEmittersFromRaw(raw: Any?): List<NotificationEmitter> =
    (raw as? List<*>).orEmpty().mapNotNull { item ->
        val m = item as? Map<*, *> ?: return@mapNotNull null
        val trigger = m["trigger"] as? String ?: return@mapNotNull null
        NotificationEmitter(
            trigger = trigger,
            source = m["source"] as? String ?: "",
            dataKeys = stringList(m["dataKeys"]),
            dataNote = (m["dataNote"] as? String)?.takeIf { it.isNotBlank() },
        )
    }
/** Parses the "not gated here" list. A send with no template id is dropped. */
fun ungatedSendsFromRaw(raw: Any?): List<UngatedSend> =
    (raw as? List<*>).orEmpty().mapNotNull { item ->
        val m = item as? Map<*, *> ?: return@mapNotNull null
        val templateId = m["templateId"] as? String ?: return@mapNotNull null
        UngatedSend(
            templateId = templateId,
            trigger = m["trigger"] as? String ?: "",
            source = m["source"] as? String ?: "",
        )
    }

/** Parses one stored override (flat fields + lockReason + per-stream gates). */
fun notificationOverrideFromMap(o: Map<*, *>): NotificationOverride = NotificationOverride(
    enabled = o["enabled"] as? Boolean ?: true,
    channels = boolMap(o["channels"]),
    lockedEnabled = o["lockedEnabled"] as? Boolean ?: false,
    locked = boolMap(o["locked"]),
    lockReason = (o["lockReason"] as? String)?.takeIf { it.isNotBlank() },
    streams = (o["streams"] as? Map<*, *>).orEmpty().entries.mapNotNull { (k, v) ->
        val sk = k as? String ?: return@mapNotNull null
        val g = v as? Map<*, *> ?: return@mapNotNull null
        sk to StreamGate(
            enabled = g["enabled"] as? Boolean,
            channels = boolMap(g["channels"]),
            lockedEnabled = g["lockedEnabled"] as? Boolean,
            locked = boolMap(g["locked"]),
        )
    }.toMap(),
)

private fun StreamGate.toPayload(): Map<String, Any> = buildMap {
    enabled?.let { put("enabled", it) }
    if (channels.isNotEmpty()) put("channels", channels)
    if (lockedEnabled == true) put("lockedEnabled", true)
    val onLocks = locked.filterValues { it }
    if (onLocks.isNotEmpty()) put("locked", onLocks)
}

/**
 * The saveBusinessNotificationOverride payload for this override. Locks are sent
 * only when true (backend zod is z.literal(true)); empty stream gates are omitted;
 * lockReason is omitted when null and sent as "" only to clear (clamped to 300).
 */
fun NotificationOverride.toCallablePayload(): Map<String, Any> = buildMap {
    put("enabled", enabled)
    put("channels", channels)
    if (lockedEnabled) put("lockedEnabled", true)
    val onLocks = locked.filterValues { it }
    if (onLocks.isNotEmpty()) put("locked", onLocks)
    lockReason?.let { put("lockReason", it.take(300)) }
    val streamPayload = streams.mapNotNull { (s, g) ->
        val gp = g.toPayload()
        if (gp.isEmpty()) null else s to gp
    }.toMap()
    if (streamPayload.isNotEmpty()) put("streams", streamPayload)
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin's OWN notification receive-prefs (the operator-as-recipient side)
// ─────────────────────────────────────────────────────────────────────────────

/** The three channels in fixed display order. */
val NOTIF_CHANNELS: List<String> = listOf("email", "sms", "push")

/** Human label for a channel id. */
fun notifChannelLabel(channel: String): String = when (channel.trim().lowercase()) {
    "email" -> "Email"
    "sms" -> "SMS"
    "push" -> "Push"
    else -> channel
}

/**
 * The admin/operator's OWN notification receive-preferences. Mirrors the backend
 * UserNotificationPrefs hybrid shape (byKey wins over byCategory). Stored at
 * `staff/{uid}.notificationPrefs` via the getMyAdminNotificationPrefs /
 * saveMyAdminNotificationPrefs callables. The operator sees only the channels the
 * business gate enabled; a locked or catalog-required channel is forced on (read-only).
 */
data class AdminNotificationPrefs(
    /** notificationKey -> { channel -> on/off }. The most specific override. */
    val byKey: Map<String, Map<String, Boolean>> = emptyMap(),
    /** category -> { channel -> on/off }. Fallback when no per-key value is set. */
    val byCategory: Map<String, Map<String, Boolean>> = emptyMap(),
    /** marketingCategory -> opted in. (Admin has no marketing notifications today.) */
    val marketingOptIn: Map<String, Boolean> = emptyMap(),
) {
    /**
     * The admin's effective receive value for a free (non-forced) channel. Mirrors the
     * server resolveChannels default EXACTLY: byKey wins, then byCategory, then the
     * catalog default (email on; sms/push off until the operator opts in).
     */
    fun effectiveReceive(entry: NotificationCatalogEntry, channel: String): Boolean =
        byKey[entry.key]?.get(channel)
            ?: byCategory[entry.category]?.get(channel)
            ?: (channel == "email")

    /** Returns a copy with byKey[key][channel] set to [value] (used by the toggle). */
    fun withByKeyChannel(key: String, channel: String, value: Boolean): AdminNotificationPrefs {
        val row = (byKey[key] ?: emptyMap()) + (channel to value)
        return copy(byKey = byKey + (key to row))
    }
}

/**
 * Is [channel] OFFERED to the recipient of [stream] for [entry]? The business gate
 * enabled it: the channel is in the catalog's allowedChannels, the stream's whole
 * notification is enabled, and the operator did not switch that channel off for the
 * stream. Mirrors the server gate. Pure; tested.
 */
fun NotificationMatrix.channelOfferedToUser(
    entry: NotificationCatalogEntry,
    channel: String,
    stream: String,
): Boolean =
    channel in entry.allowedChannels &&
        streamEffectiveEnabled(entry.key, stream) &&
        streamEffectiveChannel(entry.key, stream, channel)

/**
 * Is [channel] FORCED on (read-only) for the recipient of [stream]? Either the catalog
 * requires it, or the operator locked it for that stream (or flat, inherited). A forced
 * channel cannot be turned off by the recipient. Pure; tested.
 */
fun NotificationMatrix.channelForcedForUser(
    entry: NotificationCatalogEntry,
    channel: String,
    stream: String,
): Boolean =
    entry.required[channel] == true ||
        streamEffectiveLockedEnabled(entry.key, stream) ||
        streamEffectiveChannelLocked(entry.key, stream, channel)

/**
 * Select-all (#390 Android parity): flips every EDITABLE channel of every row in
 * [entries] to [on], within [stream]'s gate. "Editable" is exactly what a row's own
 * toggle lets the operator change: a channel [matrix] currently OFFERS on this stream
 * ([channelOfferedToUser]) that is NOT forced on ([channelForcedForUser]). Forced
 * channels stay pinned on and read-only, same as `AdminReceiveRow`, so a bulk flip must
 * skip them too rather than writing a `byKey` entry the gate would just override.
 *
 * A pure fold over [withByKeyChannel] (itself a merge, not a rebuild, so calling it
 * repeatedly never drops an unrelated key or channel). The web fix for #390 chains one
 * `applyBulkToggle` call per stream because "editable" is gate-scoped per stream;
 * `AdminNotificationPrefsScreen`'s page-level bulk does the same here, then commits the
 * whole result through ONE `saveMyAdminNotificationPrefs` call rather than the per-row
 * optimistic save this screen normally uses (which would otherwise fire one callable
 * round trip per channel — roughly two dozen for a full page).
 */
fun AdminNotificationPrefs.applyBulkToggle(
    matrix: NotificationMatrix,
    entries: List<NotificationCatalogEntry>,
    stream: String,
    on: Boolean,
): AdminNotificationPrefs {
    var next = this
    entries.forEach { entry ->
        NOTIF_CHANNELS.forEach { channel ->
            if (matrix.channelOfferedToUser(entry, channel, stream) &&
                !matrix.channelForcedForUser(entry, channel, stream)
            ) {
                next = next.withByKeyChannel(entry.key, channel, on)
            }
        }
    }
    return next
}

/**
 * THE RECIPIENT-LAYER VOCABULARY (#451).
 *
 * `AdminNotificationPrefsScreen` is a RECIPIENT seat: it edits one person's own
 * receive prefs. The only thing this layer can honestly guarantee about a
 * forced channel is that the person sitting here does not decide it — the
 * business gate does. It cannot promise the notification keeps arriving,
 * because the gate can switch the whole row (or that channel) off in Business
 * Settings and `resolveChannels` honors that even for a catalog-required
 * channel (ruling #7, warn-but-allow-off).
 *
 * So the pill says this and never "Required" or "Always on": it names WHO
 * decides, and promises nothing about permanence. Mirrors
 * CHANNEL_SET_BY_BUSINESS in `auntieos-admin/src/lib/myNotificationsFormat.ts`,
 * and sits one layer in from the portal's "Set by Tribe Tails Pet Care."
 */
const val NOTIF_CHANNEL_SET_BY_BUSINESS = "Set by your business"
/**
 * Plain-language reason a forced channel can't be changed on this screen. The
 * operator's own lockReason wins; otherwise the built-in fallback strings.
 * Empty when not forced. Both fallbacks name the layer that decides and where
 * it can be changed; neither says the channel will always send.
 */
fun NotificationMatrix.channelForcedReason(
    entry: NotificationCatalogEntry,
    channel: String,
    stream: String,
): String {
    if (!channelForcedForUser(entry, channel, stream)) return ""
    lockReasonFor(entry.key)?.let { return it }
    return if (entry.required[channel] == true) {
        "Set by the notification itself; your choice here can't turn it off."
    } else {
        "Set in your business settings; your choice here can't turn it off."
    }
}

/**
 * Does the admin/operator RECEIVE this notification on [stream]? The entry targets
 * that stream, the stream's gate keeps it enabled, and at least one channel is
 * offered. Drives section visibility on the prefs screen. Pure; tested.
 */
fun NotificationCatalogEntry.adminReceives(matrix: NotificationMatrix, stream: String): Boolean {
    if (stream !in audiences) return false
    if (!matrix.streamEffectiveEnabled(key, stream)) return false
    return allowedChannels.any { matrix.channelOfferedToUser(this, it, stream) }
}
