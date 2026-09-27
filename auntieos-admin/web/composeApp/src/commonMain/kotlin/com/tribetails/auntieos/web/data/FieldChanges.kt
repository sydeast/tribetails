package com.tribetails.auntieos.web.data

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/** A field a desktop merge write sets (or, with a null value, deletes). Same type the kinfolk merge uses. */
typealias FieldChange = KinfolkFieldChange

/** Same configuration as `jsonOut` in FirestoreInterop.jvm.kt, so a diffed value is exactly what a write would send. */
private val diffJson = Json { encodeDefaults = true; ignoreUnknownKeys = true; isLenient = true }

/** The map field diffed key by key on both kin and kinfolk, so one custom field's edit never rewrites another's. */
internal const val PER_KEY_MAP_FIELD = "formValues"

/**
 * #829 / #895: the fields a desktop update writes, which are only the top-level
 * keys whose value in [after] differs from [before] (the record the caller read).
 * `formValues` is diffed per key: a changed or added key is one change at
 * `formValues.<key>`, a removed key is a delete at that path. `_id` and
 * [excluded] never appear. Empty means nothing to write.
 */
internal fun fieldChanges(before: JsonObject, after: JsonObject, excluded: Set<String> = emptySet()): List<FieldChange> {
    val changes = mutableListOf<FieldChange>()
    for ((key, value) in after) {
        if (key == "_id" || key in excluded) continue
        val old = before[key]
        if (key == PER_KEY_MAP_FIELD && value is JsonObject && (old == null || old is JsonObject)) {
            val oldMap = old as? JsonObject ?: JsonObject(emptyMap())
            for ((k, v) in value) if (oldMap[k] != v) changes += FieldChange(listOf(key, k), v)
            for (k in oldMap.keys) if (k !in value) changes += FieldChange(listOf(key, k), null)
        } else if (old != value) {
            changes += FieldChange(listOf(key), value)
        }
    }
    return changes
}

/**
 * #895: what a desktop kin (pet) UPDATE writes: only the fields [edited] changed
 * relative to [loaded], the record the caller read. A kin save never rewrites a
 * field it did not change, so a household's portal edit to `vaccinations`, a tag
 * added on admin web, or a field this model does not carry survives it.
 * Admin Android does the same through `AuntieRepository.updateKinFields`.
 */
fun kinChanges(loaded: Kin, edited: Kin): List<FieldChange> = fieldChanges(
    diffJson.encodeToJsonElement(Kin.serializer(), loaded).jsonObject,
    diffJson.encodeToJsonElement(Kin.serializer(), edited).jsonObject,
)
