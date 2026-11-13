package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * What a settings save from THIS surface is allowed to write: the fields that
 * actually changed since the document was read, and nothing else.
 *
 * WHY. `business_settings/business_settings` is one document with many editors.
 * The React admin patches it per section
 * (`auntieos-admin/src/api/settingsWrite.ts`), and Android writes a field diff
 * built by its own `BusinessSettingsDiff.kt`. The desktop console was the last
 * whole-object writer: `platformSaveBusinessSettings` serialised the entire
 * model and merged it, and a `merge` write protects fields OUTSIDE the written
 * map while doing nothing about stale fields INSIDE it. Every field of this
 * model was inside it, so a panel saving one toggle wrote all ~50 back at
 * whatever this console had last polled — reverting anything the phone or the
 * React admin had changed since. Issue #519 multiplies the exposure (three new
 * panels, all saving the same document), which is what made this worth closing
 * in the same change rather than later.
 *
 * HOW. Both copies are serialised with the SAME `Json` the write path uses, and
 * the two objects are compared key by key. That is deliberately not a
 * hand-maintained field registry like Android's: this model is `@Serializable`
 * and the encoder already enumerates exactly the fields that would have been
 * written, so a field added to `BusinessSettings` is diffed the day it is added
 * and cannot silently stop saving. (Android hand-writes its list because its
 * model is a Firestore POJO with no encoder to ask, and it pays for that with a
 * reflection drift-guard test.)
 *
 * SERVER-OWNED KEYS ARE NEVER DIFFED. `_id` is the document id alias, and
 * `updatedAt`/`updatedBy` are stamped at write time; round-tripping a stale
 * stamp is how "last saved by" starts lying. Since #1593 the
 * `saveBusinessSettings` callable stamps both itself and refuses a client that
 * sends either.
 *
 * A FIELD CLEARED TO BLANK IS A CHANGE and is written as `""`. Skipping blanks
 * would make "take my Venmo handle off the invoice" the one edit no screen can
 * perform.
 */

/**
 * Keys the client must never send. See the file header. #1593: the
 * `saveBusinessSettings` callable refuses every one of these by name
 * (`SERVER_OWNED_SETTINGS_FIELDS` in `businessSettingsChecks.ts`); the four
 * calendar-sync receipts are not on this model, and are listed so a field
 * added for them later still never goes out.
 */
internal val BUSINESS_SETTINGS_SERVER_OWNED: Set<String> = setOf(
    "_id",
    "updatedAt",
    "updatedBy",
    "calendarSyncLastRunAt",
    "calendarSyncLastStatus",
    "calendarSyncLastImported",
    "calendarSyncLastError",
)

/**
 * #2205: fields this save never sends, because they change through a callable
 * of their own: the two tag lists, one named tag at a time through
 * `changeBusinessTags` and `removeBusinessTag`. A whole list sent here replaced
 * the stored one, and the server now refuses a changed list. Left out here so a
 * stale tag list in this console's baseline can never ride along with an
 * unrelated panel's save and get it refused.
 */
internal val BUSINESS_SETTINGS_SAVED_ELSEWHERE: Set<String> = setOf("householdTags", "petTags")

/**
 * #1593: the map fields the server REPLACES whole (`WHOLE_MAP_SETTINGS_FIELDS`
 * in `businessSettingsChecks.ts`), so a removed KinCare type is removed. Every
 * other map field is merged key by key on the server.
 */
internal val BUSINESS_SETTINGS_WHOLE_MAP_FIELDS: Set<String> =
    setOf("serviceRates", "serviceDurations", "serviceStartTimeBooking")

/**
 * The fields [edited] changes relative to [loaded], as the JSON the write path
 * sends. Empty means "do not write" — not even the stamp, because `updatedAt`
 * says when the document last CHANGED and moving it for a save that changed
 * nothing makes it lie.
 *
 * [loaded] must be the copy the stream last handed over, never a fresh read: a
 * re-read to diff against would hand back exactly the concurrent edit this is
 * protecting.
 */
internal fun businessSettingsChangedFields(
    loaded: BusinessSettings,
    edited: BusinessSettings,
    codec: Json,
): Map<String, JsonElement> {
    val before = codec.encodeToJsonElement(BusinessSettings.serializer(), loaded).jsonObject
    val after = codec.encodeToJsonElement(BusinessSettings.serializer(), edited).jsonObject
    val changes = LinkedHashMap<String, JsonElement>()
    for ((key, value) in after) {
        if (key in BUSINESS_SETTINGS_SERVER_OWNED) continue
        if (key in BUSINESS_SETTINGS_SAVED_ELSEWHERE) continue
        if (before[key] != value) changes[key] = value
    }
    return changes
}

/**
 * #1593: the `changes` map the `saveBusinessSettings` callable receives: the
 * fields [businessSettingsChangedFields] names, with every key-by-key-merged
 * map cut down to the keys that changed.
 *
 * WHY CUT. The server merges a nested map (`paymentOptions`, `businessHours`,
 * `mytribePortal`) key by key and checks every key it is sent. Sending the
 * whole map would echo back keys this console never touched, and one the
 * server does not accept (a payment id it does not list, a day name another
 * client spelled differently, a portal theme no longer offered) would refuse
 * the whole save over a value the operator never edited. Under a key-by-key
 * merge, an unchanged key written back is a no-op anyway, so leaving it out
 * changes nothing that is stored.
 *
 * The three [BUSINESS_SETTINGS_WHOLE_MAP_FIELDS] go whole: the server replaces
 * them, so a key left out is a key removed. Lists go whole too (the server
 * replaces arrays). A nested map that became empty goes as `{}`, which the
 * server stores as an empty map.
 *
 * A key removed from a merged map is not removed on the server: a key-by-key
 * merge has no way to say "delete". No panel here removes one (the weekly hours
 * always carry all seven days, the payment editor writes all eleven methods).
 */
internal fun businessSettingsSaveChanges(
    loaded: BusinessSettings,
    edited: BusinessSettings,
    codec: Json,
): Map<String, JsonElement> {
    val before = codec.encodeToJsonElement(BusinessSettings.serializer(), loaded).jsonObject
    val changes = businessSettingsChangedFields(loaded, edited, codec)
    val out = LinkedHashMap<String, JsonElement>()
    for ((key, value) in changes) {
        out[key] = if (key in BUSINESS_SETTINGS_WHOLE_MAP_FIELDS) value else changedLeaves(before[key], value) ?: value
    }
    return out
}

/**
 * [after] cut down to what differs from [before], walking into maps the way
 * the server's merge does. Null when nothing differs.
 */
private fun changedLeaves(before: JsonElement?, after: JsonElement): JsonElement? {
    if (before == after) return null
    if (after !is JsonObject || before !is JsonObject || after.isEmpty()) return after
    val out = LinkedHashMap<String, JsonElement>()
    for ((key, value) in after) {
        changedLeaves(before[key], value)?.let { out[key] = it }
    }
    return if (out.isEmpty()) null else JsonObject(out)
}
