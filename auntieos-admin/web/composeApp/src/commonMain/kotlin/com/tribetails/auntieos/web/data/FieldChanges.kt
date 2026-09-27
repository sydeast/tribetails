package com.tribetails.auntieos.web.data

import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
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
 * Each map field named in [perKeyMaps] (by default `formValues`) is diffed per
 * key: a changed or added key is one change at `<field>.<key>`, a removed key is
 * a delete at that path. `_id` and [excluded] never appear. Empty means nothing
 * to write.
 */
internal fun fieldChanges(
    before: JsonObject,
    after: JsonObject,
    excluded: Set<String> = emptySet(),
    perKeyMaps: Set<String> = setOf(PER_KEY_MAP_FIELD),
): List<FieldChange> {
    val changes = mutableListOf<FieldChange>()
    for ((key, value) in after) {
        if (key == "_id" || key in excluded) continue
        val old = before[key]
        if (key in perKeyMaps && value is JsonObject && (old == null || old is JsonObject)) {
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

/**
 * #994: [fieldChanges] for any desktop model. Both copies are encoded with the
 * write path's `Json`, so a diffed value is exactly what the write would send.
 * The KinTale report, template, vet clinic, household data and dynamic field
 * saves use it; each passes the record its screen loaded as [loaded].
 */
internal fun <T> modelChanges(
    serializer: SerializationStrategy<T>,
    loaded: T,
    edited: T,
    excluded: Set<String> = emptySet(),
    perKeyMaps: Set<String> = setOf(PER_KEY_MAP_FIELD),
): List<FieldChange> = fieldChanges(
    diffJson.encodeToJsonElement(serializer, loaded).jsonObject,
    diffJson.encodeToJsonElement(serializer, edited).jsonObject,
    excluded,
    perKeyMaps,
)

/**
 * #994: a KinTale report's `fieldResponses` (one entry per checklist item and
 * pet) is diffed per key as well as `formValues`, so ticking one item never
 * rewrites the other answers.
 */
internal val KIN_CARE_REPORT_PER_KEY_MAPS: Set<String> = setOf(PER_KEY_MAP_FIELD, "fieldResponses")

/**
 * #994: [VetClinic] fields the `updateVetClinic` callable does not take. A change
 * to only these is not a save (the callable could not write it), and they are
 * never in the payload. `createdAt`/`updatedAt` are server-owned.
 */
internal val VET_CLINIC_NOT_CALLABLE_FIELDS: Set<String> =
    setOf("googleMapsUrl", "submittedBy", "createdAt", "updatedAt")

/**
 * #994: the `updateVetClinic` request for [edited]: the whole editable record
 * (the callable's contract, frozen in `test/callableContract.test.ts`), plus
 * `verified` only when this save changes it relative to [loaded].
 */
internal fun updateVetClinicPayload(loaded: VetClinic, edited: VetClinic): JsonObject = buildJsonObject {
    put("clinicId", edited._id)
    put("name", edited.name.trim())
    put("phone", edited.phone.trim())
    put("address", edited.address.trim())
    put("website", edited.website.trim())
    put("hours", edited.hours.trim())
    put("notes", edited.notes.trim())
    put("isEmergency", edited.isEmergency)
    if (edited.verified != loaded.verified) put("verified", edited.verified)
}
