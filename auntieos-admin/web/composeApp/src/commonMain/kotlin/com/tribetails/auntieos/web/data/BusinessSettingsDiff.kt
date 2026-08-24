package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
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
 * stamp is how "last saved by" starts lying. The caller adds its own stamp
 * alongside the changes.
 *
 * A FIELD CLEARED TO BLANK IS A CHANGE and is written as `""`. Skipping blanks
 * would make "take my Venmo handle off the invoice" the one edit no screen can
 * perform.
 */

/** Keys the client must never round-trip. See the file header. */
internal val BUSINESS_SETTINGS_SERVER_OWNED: Set<String> = setOf("_id", "updatedAt", "updatedBy")

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
        if (before[key] != value) changes[key] = value
    }
    return changes
}
